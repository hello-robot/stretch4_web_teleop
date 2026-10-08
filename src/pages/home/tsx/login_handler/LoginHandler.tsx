import { OperatorSeat, RobotRecord } from "../robotModel";

export type RobotRooms = Record<string, RobotRecord>;

export abstract class LoginHandler {
    public onReadyCallback: () => void;

    constructor(onLoginHandlerReadyCallback: () => void) {
        this.onReadyCallback = onLoginHandlerReadyCallback;
    }

    public abstract loginState(): string;

    public abstract listRooms(
        resultCallback: (robots: RobotRooms) => void,
    ): () => void;

    public abstract logout(): Promise<undefined>;

    public abstract login(username: string, password: string): Promise<undefined>;

    public abstract forgot_password(username: string): Promise<undefined>;

    /** Email the reset code belongs to, or a rejection if the code is spent. */
    public verifyPasswordReset(code: string): Promise<string> {
        return Promise.reject(
            Error("LoginHandler.verifyPasswordReset() is not implemented"),
        );
    }

    public completePasswordReset(code: string, password: string): Promise<void> {
        return Promise.reject(
            Error("LoginHandler.completePasswordReset() is not implemented"),
        );
    }

    /** Google popup sign-in. Email/password handlers that lack it reject. */
    public loginWithGoogle(): Promise<undefined> {
        return Promise.reject(
            Error("LoginHandler.loginWithGoogle() is not implemented"),
        );
    }

    /** Email of the signed-in user, if the backend knows it. */
    public getUserEmail(): string | undefined {
        return undefined;
    }

    /** Auth uid of the signed-in user, if the backend knows it. */
    public getUserUid(): string | undefined {
        return undefined;
    }

    /**
     * Watch who holds `rooms/<robotAuthUid>/operator`. Calls with null when
     * the seat is empty. Returns an unsubscribe.
     */
    public watchOperatorSeat(
        _robotAuthUid: string,
        onSeat: (seat: OperatorSeat | null) => void,
    ): () => void {
        onSeat(null);
        return () => {};
    }

    public requestRobotLaunch(robo_uid: string, mapId?: string | null): Promise<void> {
        return Promise.resolve();
    }

    public getUserMaps(robotUid: string, callback: (maps: any) => void): void {}

    /**
     * Watch `launch_logs/<fleetId>` while a launch is in manual mode.
     * Calls with the current tail, including "". Returns an unsubscribe.
     */
    public watchLaunchLog(
        _fleetId: string,
        onLog: (text: string) => void,
    ): () => void {
        onLog("");
        return () => {};
    }

    public requestRobotStop(robo_uid: string): Promise<void> {
        return Promise.resolve();
    }

    /** Persist the map the robot should load on its next launch. */
    public setRobotMap(robo_uid: string, mapId: string | null): Promise<void> {
        return Promise.resolve();
    }

    /** Persist one feature-flag override for the robot's next launch. */
    public setRobotConfig(
        robo_uid: string,
        flag: string,
        enabled: boolean,
    ): Promise<void> {
        return Promise.resolve();
    }
}
