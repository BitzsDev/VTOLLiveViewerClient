import * as THREE from "three";

import { Application } from "../app";
import { Settings } from "../settings.js";
import { Entity } from "./entity";

const TRAIL_RATE = 1000 / 5;

interface UnitTrailPoint {
	position: THREE.Vector3;
	time: number;
}

// TODO: This still gets expensive over time. Need to do chunking, possibly just an "active" and "inactive" chunk
class SimpleUnitTrail {
	private static entityTrailCache: Record<number, UnitTrailPoint[]> = {};

	private lineMesh: THREE.Line;
	private lineGeom: THREE.BufferGeometry;
	private linePoints: UnitTrailPoint[] = [];
	private hiddenLinePoints: UnitTrailPoint[] = [];

	private get points() {
		return this.linePoints.map(p => p.position);
	}

	private hasInit = false;

	public color = {
		r: 0,
		g: 100,
		b: 255
	};
	private lastTrailTime = 0;

	constructor(private entity: Entity) {}

	public updateColor(color: { r: number; g: number; b: number }): void {
		this.color = color;
		if (this.hasInit) {
			const mat = this.lineMesh.material as THREE.LineBasicMaterial;
			mat.color.set(new THREE.Color(this.color.r, this.color.g, this.color.b));
		}
	}

	public init(): void {
		console.log(`Initializing trail for ${this.entity}`);
		const lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(this.color.r, this.color.g, this.color.b) });
		this.lineGeom = new THREE.BufferGeometry();
		this.lineMesh = new THREE.Line(this.lineGeom, lineMat);
		this.lineMesh.frustumCulled = false;
		this.lineMesh.name = "Simple unit trail line";
		this.entity.scene.add(this.lineMesh);

		if (SimpleUnitTrail.entityTrailCache[this.entity.id]) {
			const points = SimpleUnitTrail.entityTrailCache[this.entity.id];
			console.log(`Loading trail from cache for ${this.entity} with ${points.length} points`);
			this.linePoints = points;
			this.lineGeom.setFromPoints(this.points);
		}

		this.lastTrailTime = Application.time;
		this.hasInit = true;
	}

	private extendTrail() {
		this.linePoints.push({
			position: new THREE.Vector3(this.entity.position.x, this.entity.position.y, this.entity.position.z),
			time: Application.time
		});
		this.lineGeom.setFromPoints(this.points);
		this.lastTrailTime = Application.time;
	}

	private retractTrail() {
		this.linePoints.pop();
		this.lineGeom.setFromPoints(this.points);
		this.lastTrailTime = Application.time;
	}

	public run(): void {
		if (!this.hasInit) return;

		if (Application.time - this.lastTrailTime > TRAIL_RATE) this.extendTrail();

		let previousPoint = this.linePoints[this.linePoints.length - 1];
		if (previousPoint) {
			// Handle replay rewind
			while (Application.time < previousPoint.time && this.linePoints.length > 1) {
				this.retractTrail();
				previousPoint = this.linePoints[this.linePoints.length - 1];
			}

			previousPoint.position.set(this.entity.position.x, this.entity.position.y, this.entity.position.z);
		}

		if (this.lineGeom.attributes["position"] && this.linePoints.length > 2) {
			const pos = this.lineGeom.attributes["position"].array as Float32Array;
			pos[pos.length - 3] = this.entity.position.x;
			pos[pos.length - 2] = this.entity.position.y;
			pos[pos.length - 1] = this.entity.position.z;

			this.lineGeom.attributes["position"].needsUpdate = true;
		}

		const targetLength = parseInt(Settings.get("Trail Length"));
		while (this.linePoints.length > targetLength) {
			const deleted = this.linePoints.shift();
			this.hiddenLinePoints.push(deleted);
			this.lineGeom.setFromPoints(this.points);
		}

		while (this.linePoints.length < targetLength && this.hiddenLinePoints.length > 0) {
			const restored = this.hiddenLinePoints.pop();
			this.linePoints.unshift(restored);
			this.lineGeom.setFromPoints(this.points);
		}
	}

	public reset(): void {
		this.remove();
		this.init();
	}

	public remove(): void {
		if (this.linePoints.length > 0) {
			const allLinePoints = this.hiddenLinePoints.concat(this.linePoints);
			SimpleUnitTrail.entityTrailCache[this.entity.id] = allLinePoints;
			console.log(`Saving trail to cache for ${this.entity} with ${allLinePoints.length} points`);
		}
		this.linePoints = [];
		this.hiddenLinePoints = [];
		this.entity.scene.remove(this.lineMesh);
	}
}

export { SimpleUnitTrail };
