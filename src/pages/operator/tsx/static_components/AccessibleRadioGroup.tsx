import React, { useId } from "react";

import "operator/css/AccessibleRadioGroup.css";

export type AccessibleRadioOption = {
    value: string;
    label: React.ReactNode;
    ariaLabel?: string;
    description?: React.ReactNode;
    disabled?: boolean;
};

export type AccessibleRadioGroupProps = {
    legend: string;
    name: string;
    options: AccessibleRadioOption[];
    value: string;
    onChange: (value: string) => void;
    layout?: "vertical" | "horizontal";
    /** Pixel padding applied to fieldset and each option label. @default 12 */
    padding?: number;
    hasRipple?: boolean;
    disabled?: boolean;
    className?: string;
    id?: string;
};

const DEFAULT_PADDING = 12;

function spawnRipple(label: HTMLLabelElement, clientX: number, clientY: number) {
    const rect = label.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const ripple = document.createElement("span");
    ripple.className = "accessible-radio__ripple";
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${clientX - rect.left - size / 2}px`;
    ripple.style.top = `${clientY - rect.top - size / 2}px`;
    label.appendChild(ripple);
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
}

export function AccessibleRadioGroup({
    legend,
    name,
    options,
    value,
    onChange,
    layout = "vertical",
    padding = DEFAULT_PADDING,
    hasRipple = false,
    disabled = false,
    className,
    id,
}: AccessibleRadioGroupProps) {
    const reactId = useId();
    const groupId = id ?? `accessible-radio-${reactId.replace(/:/g, "")}`;

    const fieldsetClass = [
        "accessible-radio-group",
        className,
    ].filter(Boolean).join(" ");

    const optionsClass = [
        "accessible-radio-group__options",
        layout === "horizontal"
            ? "accessible-radio-group__options--horizontal"
            : "accessible-radio-group__options--vertical",
    ].join(" ");

    const handleOptionPointerDown = (
        event: React.PointerEvent<HTMLLabelElement>,
        optionDisabled: boolean,
    ) => {
        if (!hasRipple || disabled || optionDisabled) {
            return;
        }
        spawnRipple(event.currentTarget, event.clientX, event.clientY);
    };

    return (
        <fieldset
            id={groupId}
            className={fieldsetClass}
            disabled={disabled}
            style={{
                ["--accessible-radio-option-padding" as string]: `${padding}px`,
            }}
        >
            <legend className="accessible-radio-group__legend">
                {legend}
            </legend>
            <div className={optionsClass}>
                {options.map((option) => {
                    const inputId = `${groupId}-${option.value}`;
                    const descriptionId = option.description
                        ? `${inputId}-desc`
                        : undefined;
                    const isSelected = value === option.value;
                    const isOptionDisabled = Boolean(option.disabled);

                    const optionClass = [
                        "accessible-radio__option",
                        isSelected ? "accessible-radio__option--selected" : "",
                        isOptionDisabled ? "accessible-radio__option--disabled" : "",
                        hasRipple ? "accessible-radio__option--ripple" : "",
                    ].filter(Boolean).join(" ");

                    return (
                        <label
                            key={option.value}
                            className={optionClass}
                            onPointerDown={(event) =>
                                handleOptionPointerDown(event, isOptionDisabled)
                            }
                        >
                            <input
                                id={inputId}
                                type="radio"
                                className="accessible-radio__control"
                                name={name}
                                value={option.value}
                                checked={isSelected}
                                disabled={isOptionDisabled}
                                aria-label={option.ariaLabel}
                                aria-describedby={descriptionId}
                                onChange={() => onChange(option.value)}
                            />
                            <span className="accessible-radio__content">
                                <span className="accessible-radio__label">
                                    {option.label}
                                </span>
                                {option.description ? (
                                    <p
                                        id={descriptionId}
                                        className="accessible-radio__description"
                                    >
                                        {option.description}
                                    </p>
                                ) : null}
                            </span>
                        </label>
                    );
                })}
            </div>
        </fieldset>
    );
}