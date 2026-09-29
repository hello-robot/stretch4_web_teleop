export abstract class LoginHandler {
    public onReadyCallback: () => void;

    constructor(onLoginHandlerReadyCallback: () => void) {
        this.onReadyCallback = onLoginHandlerReadyCallback;
    }

    public abstract loginState(): string;

    public abstract listRooms(resultCallback);

    public abstract logout(): Promise<undefined>;

    public abstract login(
        username: string,
        password: string,
        remember_me: boolean,
    ): Promise<undefined>;

    public abstract forgot_password(username: string): Promise<undefined>;
    public requestRobotLaunch(robo_uid: string, mapId?: string): Promise<void> {
        return Promise.resolve();
    }

    public getUserMaps(robotUid: string, callback: (maps: any) => void): void {}

    public requestRobotStop(robo_uid: string): Promise<void> {
        return Promise.resolve();
    }
}
