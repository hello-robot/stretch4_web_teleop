import { FunctionProvider } from "./FunctionProvider";

export type RunStopFunctions = {
    onClick: () => void;
};

export class RunStopFunctionProvider extends FunctionProvider {
    private enabled: boolean = false;
    private runStopStateChangeCallbacks: Set<(enabled: boolean) => void> = new Set();
    private onRunStopEngaged?: () => void;

    constructor() {
        super();
        this.provideFunctions = this.provideFunctions.bind(this);
        this.updateRunStopState = this.updateRunStopState.bind(this);
        this.getRunStopState = this.getRunStopState.bind(this);
    }

    /**
     * Gets the current runstop state.
     *
     * @returns True if runstop is active, false otherwise.
     */
    public getRunStopState(): boolean {
        return this.enabled;
    }

    /**
     * Registers a callback invoked whenever the runstop state changes.
     *
     * @param callback Callback receiving boolean indicating if runstop is active.
     * @returns A cleanup function to unsubscribe the callback.
     */
    public setRunStopStateChangeCallback(
        callback: (enabled: boolean) => void
    ): () => void {
        this.runStopStateChangeCallbacks.add(callback);
        callback(this.enabled);
        return () => {
            this.runStopStateChangeCallbacks.delete(callback);
        };
    }

    /**
     * Registers a callback invoked whenever runstop becomes engaged.
     *
     * @param callback Callback executed when runstop is triggered.
     */
    public setOnRunStopEngagedCallback(callback: () => void): void {
        this.onRunStopEngaged = callback;
    }

    /**
     * Updates internal runstop state and notifies listeners.
     *
     * @param enabled Whether the robot is runstopped.
     */
    public updateRunStopState(enabled: boolean): void {
        this.enabled = enabled;
        if (enabled && this.onRunStopEngaged) {
            this.onRunStopEngaged();
        }
        for (const callback of this.runStopStateChangeCallbacks) {
            callback(this.enabled);
        }
    }

    /**
     * Provides UI handler functions for the runstop toggle button.
     *
     * @returns RunStopFunctions with click handler.
     */
    public provideFunctions(): RunStopFunctions {
        return {
            onClick: () => {
                const targetState = !this.enabled;
                if (targetState && this.onRunStopEngaged) {
                    this.onRunStopEngaged();
                }
                FunctionProvider.remoteRobot?.setToggle(
                    "setRunStop",
                    targetState,
                );
            },
        };
    }
}
