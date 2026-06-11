import { FunctionProvider } from "./FunctionProvider";
import batteryIcon1 from "../../icons/battery-1.svg";
import batteryIconCharging1 from "../../icons/battery-1-charging.svg";
import batteryIcon2 from "../../icons/battery-2.svg";
import batteryIconCharging2 from "../../icons/battery-2-charging.svg";
import batteryIcon3 from "../../icons/battery-3.svg";
import batteryIconCharging3 from "../../icons/battery-3-charging.svg";
import batteryIcon4 from "../../icons/battery-4.svg";
import batteryIconCharging4 from "../../icons/battery-4-charging.svg";
import batteryIcon5 from "../../icons/battery-5.svg";
import batteryIconCharging5 from "../../icons/battery-5-charging.svg";

export type BatteryStateFunctions = {
    getBatteryIcon: () => string;
    getPercentage: () => number;
};

export class BatteryStateFunctionProvider extends FunctionProvider {
    public percentage: number = 0.0;
    public isCharging: boolean = false;
    public percentageChangeCallback: (percentage: number) => void;
    public chargeStateChangeCallback: (isCharging: boolean) => void;

    constructor() {
        super();
        this.updateState = this.updateState.bind(this);
    }

    public updateState(percentage: number, isCharging: boolean): void {
        this.percentage = percentage;
        this.isCharging = isCharging;
        if (this.percentageChangeCallback)
            this.percentageChangeCallback(this.percentage);
        if (this.chargeStateChangeCallback)
            this.chargeStateChangeCallback(this.isCharging);
    }

    public getBatteryIcon(): string {
        if (this.percentage > 0.8) {
            return this.isCharging ? batteryIconCharging5 : batteryIcon5;
        } else if (this.percentage > 0.6) {
            return this.isCharging ? batteryIconCharging4 : batteryIcon4;
        } else if (this.percentage > 0.4) {
            return this.isCharging ? batteryIconCharging3 : batteryIcon3;
        } else if (this.percentage > 0.2) {
            return this.isCharging ? batteryIconCharging2 : batteryIcon2;
        } else {
            return this.isCharging ? batteryIconCharging1 : batteryIcon1;
        }
    }
    /**
     * Records a callback from the function provider. The callback is called
     * whenever the battery voltage changes.
     *
     * @param callback callback to function provider
     */
    public setPercentageChangeCallback(callback: (percentage: number) => void) {
        this.percentageChangeCallback = callback;
    }

    public setChargeStateChangeCallback(callback: (isCharging: boolean) => void) {
        this.chargeStateChangeCallback = callback;
    }

    public provideFunctions(): BatteryStateFunctions {
        return {
            getBatteryIcon: () => this.getBatteryIcon(),
            getPercentage: () => Math.round(this.percentage * 100)
        };
    }
}
