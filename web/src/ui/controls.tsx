import { Button as BaseButton } from "@base-ui/react/button";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { Select } from "@base-ui/react/select";
import { Tooltip } from "@base-ui/react/tooltip";
import type { ComponentProps, ReactNode } from "react";
import { AlertIcon, CheckIcon, ChevronIcon } from "./icons.tsx";

type Variant = "primary" | "secondary" | "ghost";

export function Button({
  variant = "secondary",
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: ComponentProps<typeof BaseButton> & { variant?: Variant; busy?: boolean }) {
  return (
    <BaseButton
      {...rest}
      disabled={disabled || busy}
      focusableWhenDisabled={busy}
      className={["btn", `btn-${variant}`, className].filter(Boolean).join(" ")}
    >
      {busy && <Spinner size="sm" />}
      {children}
    </BaseButton>
  );
}

export function ButtonLink({
  variant = "secondary",
  className,
  ...rest
}: ComponentProps<"a"> & { variant?: Variant }) {
  return <a {...rest} className={["btn", `btn-${variant}`, className].filter(Boolean).join(" ")} />;
}

export function Spinner({ size = "md", label }: { size?: "sm" | "md"; label?: string }) {
  return <span className={`spinner spinner-${size}`} role={label ? "status" : undefined} aria-label={label} />;
}

export function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="loading">
      <Spinner />
      <span>{children}</span>
    </div>
  );
}

export function Callout({
  tone,
  title,
  children,
}: {
  tone: "info" | "warning" | "error" | "success";
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`callout callout-${tone}`} role={tone === "error" ? "alert" : undefined}>
      <span className="callout-icon">{tone === "success" ? <CheckIcon /> : <AlertIcon />}</span>
      <div className="callout-body">
        {title && <div className="callout-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "err" | "accent"; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function TextField({
  label,
  description,
  className,
  ...input
}: ComponentProps<typeof Input> & { label: ReactNode; description?: ReactNode }) {
  return (
    <Field.Root className={["field", className].filter(Boolean).join(" ")}>
      <Field.Label className="field-label">{label}</Field.Label>
      <Input {...input} className="input" />
      {description && <Field.Description className="field-description">{description}</Field.Description>}
    </Field.Root>
  );
}

export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

export function SelectField({
  label,
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: {
  label: ReactNode;
  value: string | null;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field.Root className="field">
      <Field.Label className="field-label">{label}</Field.Label>
      <Select.Root
        items={options}
        value={value}
        disabled={disabled}
        onValueChange={(v) => {
          if (typeof v === "string") onChange(v);
        }}
      >
        <Select.Trigger className="select-trigger">
          <Select.Value className="select-value" placeholder={placeholder} />
          <Select.Icon className="select-icon">
            <ChevronIcon />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner className="select-positioner" sideOffset={6} alignItemWithTrigger={false}>
            <Select.Popup className="select-popup">
              <Select.List>
                {options.map((o) => (
                  <Select.Item key={o.value} value={o.value} disabled={o.disabled} className="select-item">
                    <Select.ItemIndicator className="select-item-indicator">
                      <CheckIcon />
                    </Select.ItemIndicator>
                    <Select.ItemText>{o.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </Field.Root>
  );
}

export function Checkbox({
  checked,
  disabled,
  onChange,
  label,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  "aria-label"?: string;
}) {
  const box = (
    <BaseCheckbox.Root
      className="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label ? undefined : ariaLabel}
      onCheckedChange={(c) => onChange(c)}
    >
      <BaseCheckbox.Indicator className="checkbox-indicator">
        <CheckIcon />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
  if (!label) return box;
  return (
    <label className="checkbox-label">
      {box}
      {label}
    </label>
  );
}

export function Hint({ text, children }: { text?: string; children: ReactNode }) {
  if (!text) return <>{children}</>;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger className="hint-trigger" render={<span tabIndex={0} />}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="tooltip">{text}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function Card({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={["card", className].filter(Boolean).join(" ")}>
      {(title || aside) && (
        <header className="card-header">
          {title && <h2 className="card-title">{title}</h2>}
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}
