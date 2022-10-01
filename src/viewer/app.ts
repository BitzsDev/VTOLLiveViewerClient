/* eslint-disable @typescript-eslint/no-empty-function */

import Stats from "stats.js";
import * as THREE from "three";

import {
	EnableRPCs, RPC, RPCController, RPCPacket
} from "../../../VTOLLiveViewerCommon/dist/src/rpc.js";
import {
	AssignID, Client, PacketType, Team, Vector3, VTOLLobby
} from "../../../VTOLLiveViewerCommon/dist/src/shared.js";
import { decompressRpcPackets } from "../../../VTOLLiveViewerCommon/src/compression";
import { getCookie } from "../../../VTOLLiveViewerCommon/src/cookieHelper";
import { IVector3, Vector } from "../../../VTOLLiveViewerCommon/src/vector";
import { IS_ALPHA, IS_DEV, WS_URL } from "../config";
import { EventBus } from "../eventBus";
import { AIAirVehicle } from "./entities/aiAirVehicle";
import { AIGroundUnit } from "./entities/aiGroundUnit";
import { MissileEntity } from "./entities/genericMissileEntity";
import { GunEntity } from "./entities/gunEntity";
import { PlayerVehicle } from "./entities/playerVehicle";
import { Entity } from "./entityBase/entity";
import { BulletManager } from "./managers/bulletManager";
import { FlareManager } from "./managers/flareManager";
import { SceneManager } from "./managers/sceneManager";
import { MapLoader } from "./map/mapLoader";
import { MeshLoader } from "./meshLoader/meshLoader";

const REPLAY_SPEEDS = [-8, -4, -2, -1, -0.5, 0, 0.5, 1, 2, 4, 8, 16, 32];

const rad = (deg: number): number => deg * Math.PI / 180;
const deg = (rad: number): number => rad * 180 / Math.PI;

const ftToMi = (ft: number): number => ft / 6076.12;
const miToFt = (mi: number): number => mi * 6076.12;

const mToFt = (m: number): number => m * 3.28084;
const ftToM = (ft: number): number => ft / 3.28084;

const msToKnots = (ms: number): number => ms * 1.94384;
const knotsToMs = (knots: number): number => knots / 1.94384;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const vec = (vector: IVector3) => `${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)}`;

function addCommas(num: number) {
	const str = num.toString().split(".");
	str[0] = str[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return str.join(".");
}

const debug_ws_usage = false;

// MessageHandler is a class within HC, this wrapper handles its RPCs
@EnableRPCs("instance")
class MessageHandler {
	constructor(public id: string, private app: Application) { }

	@RPC("in")
	NetInstantiate(id: number, ownerId: string, path: string, pos: Vector3, rot: Vector3, active: boolean) {
		this.app.handleEntitySpawn(id, ownerId, path, new Vector().set(pos), new Vector().set(rot), active);
	}

	@RPC("in")
	NetDestroy(id: number) {
		for (let i = 0; i < this.app.entities.length; i++) {
			if (this.app.entities[i].id == id) {
				// console.log(`Got despawn for ${id} - ${this.app.entities[i].displayName}`);
				this.app.entities[i].remove();
				this.app.entities.splice(i, 1);
				return;
			}
		}
	}

	@RPC("in")
	SetEntityUnitID(entityId: number, unitId: number) {
		const entity = this.app.entities.find(e => e.id == entityId);
		if (entity) entity.setUnitId(unitId);
	}
}

enum ApplicationRunningState {
	welcome = "welcome",
	lobbySelect = "lobby_select",
	replaySelect = "replay_select",
	running = "running",
	lobbyEnd = "lobby_end",
}

interface ReplaceRPCHandler {
	className: string;
	method: string;
	handler: (app: Application, rpc: RPCPacket) => boolean | RPCPacket;
}

// Handles "undoing" RPCs when the replay is running in reverse
// Can return false to prevent the RPC from executing, or can return a different RPC to execute
const replaceRPCHandlers: ReplaceRPCHandler[] = [
	{
		className: "MessageHandler",
		method: "NetInstantiate",
		handler: (app: Application, rpc: RPCPacket) => {
			const [id, ownerId, path, pos, rot, active] = rpc.args;
			app.messageHandler.NetDestroy(id);
			return false;
		}
	},
	{
		className: "MessageHandler",
		method: "NetDestroy",
		handler: (app: Application, rpc: RPCPacket) => {
			const [id] = rpc.args;
			const spawnPacket = app.replayPackets.find(p => p.className == "MessageHandler" && p.method == "NetInstantiate" && p.args[0] == id);
			if (!spawnPacket) console.error(`Attempting to undo net destroy for ${id} but no spawn packet found`);
			else return spawnPacket;
			return false;
		}
	}
];

// Master application class, singleton
@EnableRPCs("singleInstance")
class Application {
	private container: HTMLDivElement;
	public messageHandler: MessageHandler;
	public client: Client;
	public sceneManager = new SceneManager(this);
	private mapLoader = new MapLoader(this.sceneManager);
	public meshLoader: MeshLoader = new MeshLoader();
	public bulletManager: BulletManager;
	public flareManager: FlareManager;

	// TODO: Move replay to its own class
	public replayPackets: RPCPacket[] = [];
	private groupedReplayPackets: RPCPacket[][] = [];
	private onReplayChunk: (() => void) | null = null;
	private isReplay = false;
	private replayStartTime = 0;
	private currentReplayChunkReceive = 0;
	public replayCurrentTime = 0;
	private prevReplayTime = 0;
	private replaySpeed = 7;
	private get computedReplaySpeed(): number {
		return REPLAY_SPEEDS[this.replaySpeed];
	}

	public get time(): number {
		if (this.isReplay) return this.replayCurrentTime;
		return Date.now();
	}

	public static get time() {
		return this.instance.time;
	}

	public entities: Entity[] = [];

	private stats = new Stats();
	public currentFocus: Entity | null = null;
	public gameList: VTOLLobby[] = [];
	public game: VTOLLobby;
	public socket: WebSocket;

	private isUiHidden = false;

	private prevFrameTime = Date.now();
	// Any entity that can be spawned must be added to this list
	private spawnables = [PlayerVehicle, AIAirVehicle, MissileEntity, GunEntity, AIGroundUnit];

	public static instance: Application;
	public static state: ApplicationRunningState = ApplicationRunningState.welcome;
	public state: ApplicationRunningState = ApplicationRunningState.welcome;

	constructor() {
		Application.instance = this;
		this.container = document.getElementById("main-container") as HTMLDivElement;
		this.handleResize();
		this.addWindowEventHandlers();
	}

	public static setState(state: ApplicationRunningState) {
		if (state == ApplicationRunningState.lobbySelect && location.pathname == "/replay") {
			state = ApplicationRunningState.replaySelect;
			console.log(`Switching to replay select state rather than regular lobby select`);
		}
		Application.state = state;
		Application.instance.state = state;
		EventBus.$emit("state", state);
		console.log(`New application state: ${state}`);
	}

	public async init(): Promise<void> {
		this.socket = new WebSocket(WS_URL);
		this.socket.onopen = () => {
			console.log(`Websocket connected!`);
		};
		this.socket.onclose = () => console.log(`Websocket disconnected`);
		this.socket.onerror = (e) => console.log(`Websocket error: `, e);
		this.socket.onmessage = (message: MessageEvent) => this.handleWSMessage(message);

		RPCController.init((packet) => {
			const pckt = {
				...packet,
				type: PacketType.rpcPacket
			};
			this.socket.send(JSON.stringify(pckt));
		});

		EventBus.$emit("state", this.state);

		// Some testing utilities
		// Testing heightmap
		// this.mapLoader.loadHeightmapFromMission({
		// campaignId: "quickMPFlights",
		// id: "airshowFreeflight",
		// isBuiltin: true,
		// mapId: "e_coastBay",
		// name: "Free Flight / Airshow",
		// workshopId: "built-in"
		// });

		// this.offlineTestSetup();
		// this.quickTestSetup();

		// EventBus.$emit("app", this);

	}

	public async start() {
		console.log(`Application is starting!`);
		await this.sceneManager.init(this.container);
		this.bulletManager = new BulletManager(this.sceneManager);
		this.flareManager = new FlareManager(this.sceneManager);

		this.stats.showPanel(0);
		document.body.appendChild(this.stats.dom);
		this.stats.dom.classList.add("ui");

		Application.setState(ApplicationRunningState.running);

		this.run();
	}

	// Small/often changed test method
	private quickTestSetup() {
		const mat = new THREE.MeshPhongMaterial({ color: "#990000" });
		const geo = new THREE.BoxGeometry(10, 10, 10);
		const mesh = new THREE.Mesh(geo, mat);

		const euler = new THREE.Euler(rad(-42), rad(26), rad(80)); // YXZ ? What does unity use?

		// const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(euler.x, -euler.y, -euler.z));
		// quat.y *= -1;
		// quat.z *= -1;

		// console.log(`Euler: (${euler.x.toFixed(3)}, ${euler.y.toFixed(3)}, ${euler.z.toFixed(3)})  Quat: (${quat.x.toFixed(3)}, ${quat.y.toFixed(3)}, ${quat.z.toFixed(3)} ${quat.w.toFixed(3)})`);

		mesh.name = "Test";
		// mesh.setRotationFromQuaternion(quat);
		mesh.position.set(5, 0, 10);
		this.sceneManager.add(mesh);

		const cam = this.sceneManager.cameraController.fakeCamera;
		setTimeout(async () => {
			cam.position.set(-2, 57, -90);
		}, 250);

		setInterval(() => {
			euler.x += 0.01;
			euler.y += 0.01;
			const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(euler.x, euler.y, euler.z, "YXZ"));
			const q = new THREE.Quaternion(quat.x, quat.y, quat.z, quat.w);

			console.log(`Euler: (${deg(euler.x).toFixed(3)}, ${deg(euler.y).toFixed(3)}, ${deg(euler.z).toFixed(3)})  Quat: (${q.x.toFixed(3)}, ${q.y.toFixed(3)}, ${q.z.toFixed(3)} ${q.w.toFixed(3)})`);

			mesh.setRotationFromQuaternion(q);
		});
	}

	// Sets up a testing scene with a variety of entities
	private async offlineTestSetup() {
		await this.start();
		this.game = new VTOLLobby("0");
		this.game.players.push({
			entityId: 1,
			pilotName: "Chase",
			slot: 0,
			steamId: "0",
			team: Team.A,
			unitId: 0
		});
		this.messageHandler = new MessageHandler(this.game.id, this);

		let id = 1;
		const aircraft = new PlayerVehicle(this);
		await aircraft.spawn(id++, "0", "Vehicles/FA-26B", new Vector(0, 0, 0), new Vector(0, 0, 0), true);
		aircraft.UpdateData(new Vector(0, 0, 0), new Vector(0, 0, 0), new Vector(0, 0, 0), new Vector(0, 0, 0), 0);

		const aircraft2 = new PlayerVehicle(this);
		await aircraft2.spawn(id++, "0", "Vehicles/SEVTF", new Vector(20, 0, 0), new Vector(0, 0, 0), true);

		const aircraft3 = new PlayerVehicle(this);
		await aircraft3.spawn(id++, "0", "Vehicles/VTOL4", new Vector(-20, 0, 10000), new Vector(0, 0, 0), true);

		const aircraft4 = new AIAirVehicle(this);
		aircraft4.spawn(id++, "0", "Units/Allied/E-4", new Vector(-40, 0, 0), new Vector(0, 0, 0), true);
		aircraft4.UpdateData(new Vector(0, 0, 0), new Vector(0, 0, 10), new Vector(0, 0, 0), new Vector(0, 0, 0));
		// await aircraft4.spawn(id++, "0", "Vehicles/F117", new Vector(0, 0, 0), new Vector(0, 0, 0));
		this.entities.push(aircraft, aircraft2, aircraft3, aircraft4);

		const missile = new MissileEntity(this);
		missile.spawn(id++, "0", "Weapons/Missiles/AGM-145", new Vector(-20, 0, 0), new Vector(0, 0, 0));
		await missile.SyncShit(new Vector(-20, 0, 0), new Vector(0, 0, 0), new Vector(0, 0, 50), new Vector(0, 0, 0));
		this.entities.push(missile);

		const patriot = new AIGroundUnit(this);
		patriot.spawn(id++, "0", "Units/Allied/AlliedBackstopSAM", new Vector(40, 0, 0), new Vector(0, 0, 0), true);
		this.entities.push(patriot);

		for (let i = 0; i < 1; i++) {
			const ai = new AIGroundUnit(this);
			ai.spawn(id++, "0", "Units/Enemy/EnemySoldier", new Vector(Math.cos(rad(i) * 4) * 100 * (1 + i / 100), 0, Math.sin(rad(i) * 4) * 100 * (1 + i / 100)), new Vector(0, 0, 0), true);
			this.entities.push(ai);
		}

		const carrier = new AIGroundUnit(this);
		await carrier.spawn(id++, "0", "Units/Allied/AlliedCarrier", new Vector(-200, 0, 0), new Vector(0, 0, 0), true);
		this.entities.push(carrier);


		const cam = this.sceneManager.cameraController.fakeCamera;
		setTimeout(async () => {
			cam.position.set(-2, 57, -90);
			this.setFocusTo(aircraft);
			console.log(`Test post-load setup!`);
			this.messageHandler.NetInstantiate(id++, "0", "HPEquips/AFighter/fa26_gun", new Vector(0, 0, 0), new Vector(0, 0, 0), true);

			missile.setUnitId(100);
			// setInterval(() => {
			// 	const gun = this.getEntityById(id - 1) as GunEntity;
			// 	gun.FireBullet(new Vector(aircraft.position.x, aircraft.position.y, aircraft.position.z), new Vector(0, 0, 10000));
			// }, 0);

			aircraft.SetLock(100, true);
			// aircraft4.UpdateData(new Vector(0, 0, 0), new Vector(0, 0, 10), new Vector(0, 0, 0), new Vector(0, 0, 0));
		}, 250);
	}

	private packetIsInTimeframe(packet: RPCPacket) {
		const fromRecordingStart = (packet.timestamp ?? Date.now()) - this.replayStartTime;

		if (this.computedReplaySpeed > 0) {
			return fromRecordingStart <= this.replayCurrentTime && fromRecordingStart > this.prevReplayTime;
		} else if (this.computedReplaySpeed < 0) {
			return fromRecordingStart >= this.replayCurrentTime && fromRecordingStart < this.prevReplayTime;
		}
	}

	private runReplay(expectedDt: number): number {
		if (expectedDt > 1000) {
			console.warn(`Expected dt excessive ${expectedDt}`);
			expectedDt = 1000 / 60;
		}
		// console.log(expectedDt, this.computedReplaySpeed, this.replayCurrentTime);
		this.replayCurrentTime += expectedDt * this.computedReplaySpeed;

		const packets: RPCPacket[] = [];
		const currentPacketGroup = this.groupedReplayPackets[Math.floor(this.replayCurrentTime / 1000)] ?? [];
		const prevPacketGroup = this.groupedReplayPackets[Math.floor(this.prevReplayTime / 1000)] ?? [];
		[...currentPacketGroup, ...prevPacketGroup].forEach(packet => {
			if (!this.packetIsInTimeframe(packet)) return;
			if (this.computedReplaySpeed < 0) {
				const handler = replaceRPCHandlers.find(h => h.className == packet.className && h.method == packet.method);
				if (handler) {
					const res = handler.handler(this, packet);
					if (!res) return;
					if (typeof res == "object") packets.push(res);
					else packets.push(packet);
				} else {
					packets.push(packet);
				}
			} else {
				packets.push(packet);
			}
		});
		packets.forEach(packet => RPCController.handlePacket(packet));
		this.prevReplayTime = this.replayCurrentTime;

		return expectedDt * this.computedReplaySpeed;
	}

	private run(): void {
		this.stats.begin();

		const d = Date.now();
		let dt = d - this.prevFrameTime;
		if (this.isReplay) {
			dt = this.runReplay(dt);
		}
		this.prevFrameTime = d;

		this.entities.forEach(entity => {
			if (entity.isActive) entity.update(dt);
		});

		this.bulletManager.update(dt);
		this.flareManager.update(dt);

		this.gameList = this.gameList.filter(g => g.isOpen);

		this.sceneManager.run();
		this.sceneManager.postFrame();

		// Track websocket usage
		if (debug_ws_usage && this.tick++ % 60 == 0) {
			const dBytes = this.bytes - this.lBytes;
			const dMessages = this.messages - this.lMessages;
			console.log(`Messages: ${this.messages} Bytes: ${(this.bytes / 1000).toFixed(0)}kb. Delta Messages: ${dMessages} Delta Bytes: ${(dBytes / 1000).toFixed(0)}kb. RPCs per packet: ${(this.rpcs / this.messages).toFixed(2)}`);
			this.lBytes = this.bytes;
			this.lMessages = this.messages;
		}

		this.stats.end();
		requestAnimationFrame(() => this.run());
	}

	@RPC("in")
	public CreateLobby(id: string) {
		if (this.gameList.find(g => g.id == id)) {
			console.log(`Game ${id} already exists!`);
			return;
		}
		this.gameList.push(new VTOLLobby(id));
		EventBus.$emit("lobbies", this.gameList);

		if (IS_DEV && !this.game) {
			setTimeout(() => {
				if (!this.game) { // Make sure we didn't get a game in the meantime
					const validGame = this.gameList.find(g => g.isConnected);
					if (validGame) {
						console.log(`Dev connecting to game ${validGame.name} (${validGame.id})`);
						this.subscribe(validGame);
					}
				}
			}, 250);
		}
	}

	@RPC("out")
	public requestJoinLobby(id: string) { }

	@RPC("out")
	public requestJoinPrivateLobby(id: string, password: string) { }

	@RPC("out")
	genNewAlphaKey(key: string, adminPassword: string) { }

	// private tempEmit = true;
	private addEntity(entity: Entity): void {
		this.entities.push(entity);
		EventBus.$emit("entities", this.entities);
		// if (this.tempEmit) EventBus.$emit("entities", this.entities);
		// else console.warn(`Temp emit go brrrr`);

		// this.tempEmit = false;
	}

	public setFocusTo(entity: Entity): void {
		if (this.currentFocus && this.currentFocus != entity) {
			// Remove parenting from whatever we are currently focused on
			const camPos = this.sceneManager.camera.getWorldPosition(new THREE.Vector3());
			this.currentFocus.object.remove(this.sceneManager.camera);
			this.sceneManager.cameraController.set(camPos);
		}

		this.currentFocus = entity;

		// This bullshit is to parent the camera to the entity
		this.sceneManager.cameraController.lerpCamTo(
			entity.position.x,
			entity.position.y,
			entity.position.z,
			() => {
				const camPos = this.sceneManager.camera.getWorldPosition(new THREE.Vector3());
				camPos.subVectors(camPos, new THREE.Vector3(
					entity.position.x,
					entity.position.y,
					entity.position.z,
				));
				this.sceneManager.cameraController.set(camPos);
				this.sceneManager.cameraController.orbit.target.set(0, 0, 0);
				entity.object.add(this.sceneManager.camera);
			});
	}

	public handleEntitySpawn(id: number, ownerId: string, path: string, position: Vector, rotation: Vector, isAcitve: boolean) {
		// Resolve the class that handles this type of entity 
		let EntityClass;
		for (let i = 0; i < this.spawnables.length; i++) {
			const eClass = this.spawnables[i];
			if (Array.isArray(eClass.spawnFor)) {
				const match = eClass.spawnFor.map(c => c.toLowerCase()).includes(path.trim().toLowerCase());
				if (match) {
					EntityClass = eClass;
					break;
				}
			} else {
				const v = eClass.spawnFor.test(path.trim());
				if (v) {
					EntityClass = eClass;
					break;
				}
			}
		}

		if (!EntityClass) {
			// We don't care about HPEquips and Rearm points so don't log errors for that
			if (!path.startsWith("HPEquips") && !path.includes("Rearm")) console.warn(`Unable to locate entity handler for ${path}`);
			return;
		}

		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore
		// console.log(EntityClass.constructor.toString().match(/function (\w*)/)[1]);
		// console.log(`Entity net.prototype instantiate ${path} [${id}] owner: ${ownerId}. Entity: ${EntityClass}`);
		const entity = new EntityClass(this);
		entity.spawn(id, ownerId, path, position, rotation, isAcitve);
		this.addEntity(entity);
	}

	// Sets the game we wish to view
	public async subscribe(gameRef: VTOLLobby | string) {
		if (Application.state != ApplicationRunningState.running) this.start();

		let game: VTOLLobby | string | undefined = gameRef;
		if (typeof game == "string") game = this.gameList.find(g => g.id == game);
		if (!game) throw new Error(`Cannot find game by ID: ${gameRef}`);

		this.entities.forEach(entity => entity.remove());
		this.entities = [];
		if (this.messageHandler) RPCController.deregister(this.messageHandler);

		console.log(`Setting focused game to ${game.name} (${game.id})`);
		this.client.subscribe(game.id);
		this.game = game;
		this.messageHandler = new MessageHandler(game.id, this);

		this.mapLoader.loadHeightmapFromMission(await this.game.waitForMissionInfo());
	}

	public requestReplay(replayId: string, onProgress?: (progress: number) => void) {
		this.client.replayGame(replayId);
		return new Promise<void>(res => {
			this.currentReplayChunkReceive = 0;
			this.onReplayChunk = () => {
				this.currentReplayChunkReceive++;
				if (this.currentReplayChunkReceive == this.client.expectedReplayChunks) {
					res();
					this.onReplayChunk = null;
				}
				if (onProgress) onProgress(this.currentReplayChunkReceive / this.client.expectedReplayChunks);
			};
		});
	}

	public async beginReplay(id: string) {
		console.log(`Beginning replay with ${this.replayPackets.length} packets`);
		this.isReplay = true;
		if (this.replayPackets[0].timestamp == undefined) {
			console.error(`Replay packet 0 has no timestamp`);
			return;
		}
		this.replayStartTime = this.replayPackets[0].timestamp;
		this.replayCurrentTime = this.replayStartTime;
		this.messageHandler = new MessageHandler(id, this);
		this.game = new VTOLLobby(id);
		this.start();
		this.mapLoader.loadHeightmapFromMission(await this.game.waitForMissionInfo());
	}

	private raycastEntitiesFromMouse(screenX: number, screenY: number, validEntities: Entity[]) {
		const raycaster = new THREE.Raycaster();
		const x = (screenX / window.innerWidth) * 2 - 1;
		const y = -(screenY / window.innerHeight) * 2 + 1;

		const mouse = new THREE.Vector2(x, y);
		raycaster.setFromCamera(mouse, this.sceneManager.camera);

		const entities = validEntities.map(entity => entity.getInteractionMesh()).filter(m => !!m);
		const intersections = raycaster.intersectObjects(entities);
		return intersections;
	}

	private handleMouseClick(e: MouseEvent) {
		if (Application.state != ApplicationRunningState.running) return;

		const validEntities = this.entities.filter(entity => entity.isActive);
		const intersections = this.raycastEntitiesFromMouse(e.clientX, e.clientY, validEntities);
		if (intersections.length > 0) {
			const entity = validEntities.find(e => e.isInteractionMesh(intersections[0].object, intersections[0].instanceId));
			if (entity) {
				this.setFocusTo(entity);
				return;
			}
		}

		this.sceneManager.overlayElements.forEach(elm => {
			if (elm.onDblClick && elm.isInBounds(e.clientX, e.clientY)) {
				elm.onDblClick(e);
			}
		});
	}

	// Websocket debug
	private messages = 0;
	private rpcs = 0;
	private bytes = 0;
	private lMessages = 0;
	private lBytes = 0;
	private tick = 0;

	public packets: RPCPacket[] = [];

	private async handleWSMessage(message: MessageEvent) {
		this.messages++;

		if (typeof message.data == "string") {
			this.bytes += message.data.length;
			const packet = JSON.parse(message.data) as AssignID | RPCPacket;

			if ("type" in packet && packet.type == PacketType.assignId) {
				this.client = new Client(packet.id);

				// If we have an alpha key, lets send it now that we have our ID
				const alphaKey = getCookie("alpha_key");
				if (IS_ALPHA && alphaKey) {
					console.log(`Sending alpha key`);
					this.client.setAlphaKey(alphaKey);
				}

			} else {
				RPCController.handlePacket(packet as RPCPacket);
				this.rpcs++;
			}
		} else {
			const data = message.data as Blob;
			const bytes = new Uint8Array(await data.arrayBuffer());
			this.bytes += bytes.length;

			const headerBytes = bytes.slice(0, "REPLAY".length);
			const header = String.fromCharCode(...headerBytes);
			if (header == "REPLAY") {
				this.handleReplayChunk(bytes);
			} else {
				RPCController.handlePacket(bytes);
				const rpcs = decompressRpcPackets([...bytes]);
				this.rpcs += rpcs.length;
			}
		}
	}

	private handleReplayChunk(bytes: Uint8Array) {
		const rpcs = decompressRpcPackets([...bytes.slice("REPLAY".length)]);
		this.replayPackets.push(...rpcs);
		console.log(`Got replay chunk ${this.currentReplayChunkReceive} with ${rpcs.length} packets (${bytes.length} bytes)`);

		if (rpcs[0].timestamp == undefined) {
			console.error(`Replay packet chunk ${this.currentReplayChunkReceive} packet 0 has no timestamp`);
			// Interpolate timestamps
			const msPerChunk = 30 * 1000;
			const tsStep = msPerChunk / rpcs.length;
			rpcs.forEach((rpc, idx) => {
				rpc.timestamp = this.currentReplayChunkReceive * msPerChunk + tsStep * idx;
			});
		}

		rpcs.forEach(rpc => {
			const sec = Math.floor((rpc.timestamp ?? Date.now()) / 1000);
			if (!this.groupedReplayPackets[sec]) this.groupedReplayPackets[sec] = [];
			this.groupedReplayPackets[sec].push(rpc);
		});

		if (this.onReplayChunk) this.onReplayChunk();
		else console.warn(`Received replay chunk without onReplayChunk callback`);
	}

	public getEntityByUnitId(unitId: number) {
		return this.entities.find(e => e.unitId == unitId);
	}

	public getEntityById(id: number) {
		return this.entities.find(e => e.id == id);
	}

	public getEntityByPlayerName(name: string) {
		return this.entities.find(e => e.hasFoundValidOwner && e.owner.entityId == e.id && e.owner.pilotName == name);
	}

	private handleResize(): void {
		this.sceneManager.handleResize();
	}

	private toggleUI() {
		this.isUiHidden = !this.isUiHidden;
		const elms = document.getElementsByClassName("ui");

		for (const e of elms) {
			const elm = e as HTMLDivElement;
			if (this.isUiHidden) {
				if (elm.style.display != "none") {
					elm.setAttribute("prev-display", elm.style.display);
					elm.style.display = "none";
				}
			} else {
				if (elm.style.display == "none") {
					elm.style.display = elm.getAttribute("prev-display") || "block";
				}
			}
		}
	}

	private handleKeyDown(e: KeyboardEvent) {
		if (Application.state != ApplicationRunningState.running) return;

		if (e.key == "f") this.toggleUI();
		if (e.key == "ArrowLeft") this.replaySpeed = Math.max(this.replaySpeed - 1, 0);
		if (e.key == "ArrowRight") this.replaySpeed = Math.min(this.replaySpeed + 1, REPLAY_SPEEDS.length - 1);
		console.log(`Replay speed: ${REPLAY_SPEEDS[this.replaySpeed]}`);
	}

	// private handleKeyUp(e: KeyboardEvent) {
	// 	if (e.key == "f") {
	// 		const elms = document.getElementsByClassName("ui");
	// 		for (const e of elms) {
	// 			const elm = e as HTMLDivElement;

	// 		}
	// 	}
	// }

	private addWindowEventHandlers(): void {
		window.addEventListener("resize", () => this.handleResize());
		window.addEventListener("dblclick", (e) => this.handleMouseClick(e));
		window.addEventListener("keydown", (e) => this.handleKeyDown(e));
		// window.addEventListener("keyup", (e) => this.handleKeyUp(e));
	}
}

export { Application, ApplicationRunningState, deg, rad, mToFt, ftToMi, miToFt, ftToM, msToKnots, knotsToMs, lerp, vec, addCommas };