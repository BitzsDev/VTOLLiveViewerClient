import { EnableRPCs, RPC } from "../../../../VTOLLiveViewerCommon/dist/rpc.js";
import { Team, Vector3 } from "../../../../VTOLLiveViewerCommon/dist/shared.js";
import { Application } from "../app";
import { Entity } from "../entityBase/entity";
import { Settings } from "../settings";

@EnableRPCs("instance")
class AIAirVehicle extends Entity {
	public static spawnFor: string[] = [
		"Units/Allied/ABomberAI",
		"Units/Enemy/AIUCAV",
		"Units/Enemy/ASF-30",
		"Units/Enemy/ASF-33",
		"Units/Enemy/ASF-58",
		"Units/Allied/AV-42CAI",
		"Units/Allied/E-4",
		"Units/Enemy/AEW-50",
		"Units/Enemy/EBomberAI",
		"Units/Allied/F-45A AI",
		"Units/Allied/FA-26A",
		"Units/Allied/FA-26B AI",
		"Units/Enemy/GAV-25",
		"Units/Allied/KC-49",
		"Units/Allied/MQ-31",
		"Units/Enemy/T-55 AI-E",
		"Units/Allied/T-55 AI"
	];

	constructor(app: Application) {
		const braSetting = Settings.get("BRA Readouts");
		super(app, {
			hasTrail: true,
			showInBra: braSetting == "Players and AI",
			showInSidebar: false,
			useInstancedMesh: true,
			useHostTeam: false,
			removeAfterDeath: true
		});

		Settings.instance.on("BRA Readouts", (braSetting: string) => {
			this.showInBra = braSetting == "Players and AI";
		});
	}

	// Protect AI team, don't want to inherit from host
	protected setTeam(team: Team) {
		if (this.team != Team.Unknown && this.team != team) return;

		super.setTeam(team);
	}

	public update(dt: number): void {
		super.update(dt);
	}

	protected onFirstPos(): void {
		super.onFirstPos();
		this.setActive(`AI aircraft got first position`);
	}

	@RPC("in")
	UpdateData(pos: Vector3, vel: Vector3, accel: Vector3, rot: Vector3) {
		this.updateMotion(pos, vel, accel, rot);
		if (!this.isActive) {
			console.log(`${this} received position update without being active`);
		}
	}

	@RPC("in")
	Damage() {
		this.triggerDamage();
	}

	@RPC("in")
	Die() {
		this.triggerDeath();
	}

	@RPC("in")
	Spawn() {
		this.setActive(`AI got spawn RPC`);
	}
}

export { AIAirVehicle };
