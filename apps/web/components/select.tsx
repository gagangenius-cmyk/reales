"use client";

import { Children, isValidElement, useId, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import ReactSelect, { type GroupBase, type StylesConfig } from "react-select";

interface Opt { value: string; label: string; disabled?: boolean }

const text = (n: ReactNode): string => (n == null || typeof n === "boolean" ? "" : Array.isArray(n) ? n.map(text).join("") : isValidElement(n) ? text((n.props as { children?: ReactNode }).children) : String(n));

/** Turn `<option>` / `<optgroup>` children (arrays and fragments included) into react-select options, so pages keep writing ordinary markup. */
function parse(children: ReactNode): (Opt | GroupBase<Opt>)[] {
  const out: (Opt | GroupBase<Opt>)[] = [];
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const p = c.props as { value?: string | number; label?: string; disabled?: boolean; children?: ReactNode };
    if (c.type === "option") out.push({ value: p.value === undefined ? text(p.children) : String(p.value), label: text(p.children), disabled: p.disabled });
    else if (c.type === "optgroup") out.push({ label: p.label ?? "", options: parse(p.children).filter((o): o is Opt => "value" in o) });
    else out.push(...parse(p.children)); // fragment or wrapper
  });
  return out;
}

const styles: StylesConfig<Opt, false, GroupBase<Opt>> = {
  control: (b, s) => ({ ...b, minHeight: 38, borderRadius: 8, borderColor: s.isFocused ? "var(--accent)" : "var(--border)", boxShadow: s.isFocused ? "0 0 0 1px var(--accent)" : "none", background: "var(--card, #fff)", cursor: "pointer", ":hover": { borderColor: "var(--accent)" } }),
  valueContainer: (b) => ({ ...b, padding: "2px 10px" }),
  singleValue: (b) => ({ ...b, color: "inherit" }),
  input: (b) => ({ ...b, color: "inherit" }),
  placeholder: (b) => ({ ...b, color: "var(--muted, #6b7280)" }),
  indicatorSeparator: () => ({ display: "none" }),
  dropdownIndicator: (b) => ({ ...b, padding: "0 8px", color: "var(--muted, #6b7280)" }),
  menu: (b) => ({ ...b, background: "var(--card, #fff)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", boxShadow: "0 10px 30px rgba(0,0,0,.18)" }),
  menuPortal: (b) => ({ ...b, zIndex: 9999 }),
  menuList: (b) => ({ ...b, maxHeight: 280 }),
  option: (b, s) => ({ ...b, cursor: s.isDisabled ? "not-allowed" : "pointer", opacity: s.isDisabled ? 0.45 : 1, color: "inherit", background: s.isSelected ? "var(--accent)" : s.isFocused ? "var(--card-2, #f3f4f6)" : "transparent", ...(s.isSelected ? { color: "#fff" } : {}), ":active": { background: "var(--card-2, #f3f4f6)" } }),
  groupHeading: (b) => ({ ...b, color: "var(--muted, #6b7280)", fontSize: 11, textTransform: "uppercase" }),
};

export interface SelectProps {
  name?: string; id?: string; className?: string; value?: string | number | null; defaultValue?: string | number | null; disabled?: boolean; required?: boolean; autoFocus?: boolean;
  title?: string; "aria-label"?: string; onChange?: (e: ChangeEvent<HTMLSelectElement>) => void; children?: ReactNode; placeholder?: string;
}

/**
 * Drop-in replacement for a native `<select>` built on react-select: same `<option>` children, same `value` / `defaultValue` / `onChange(e.target.value)`
 * contract, and a hidden input carrying `name` so plain GET/POST forms still submit it. Search appears when there are more than 8 choices.
 */
export function Select({ name, id, className, value, defaultValue, disabled, required, autoFocus, title, onChange, children, placeholder, ...rest }: SelectProps) {
  const uid = useId();
  const options = useMemo(() => parse(children), [children]);
  const flat = useMemo(() => options.flatMap((o) => ("options" in o ? o.options : [o])), [options]);
  const [inner, setInner] = useState<string>(defaultValue == null ? "" : String(defaultValue));
  const current = value !== undefined ? (value == null ? "" : String(value)) : inner;
  const selected = flat.find((o) => o.value === current) ?? null;
  // `input` is the native control's border/padding class; the react-select control draws its own, so only the layout classes are kept.
  const wrapper = (className ?? "").split(/\s+/).filter((c) => c && c !== "input").join(" ");

  return (
    <div className={wrapper} style={{ position: "relative", width: /\bw-/.test(wrapper) ? undefined : "100%", minWidth: 0 }} title={title}>
      <ReactSelect<Opt, false, GroupBase<Opt>>
        instanceId={id ?? uid} inputId={id} name={name} options={options} value={selected} isDisabled={disabled} isSearchable={flat.length > 8} autoFocus={autoFocus}
        placeholder={placeholder ?? (flat.length ? "Select..." : "No choices")} styles={styles} aria-label={rest["aria-label"]}
        isOptionDisabled={(o) => !!o.disabled} menuPortalTarget={typeof document === "undefined" ? undefined : document.body} menuPosition="fixed" menuPlacement="auto"
        classNamePrefix="rs" noOptionsMessage={() => "No match"}
        onChange={(o) => {
          const v = o?.value ?? "";
          setInner(v);
          onChange?.({ target: { value: v, name: name ?? "" }, currentTarget: { value: v, name: name ?? "" } } as unknown as ChangeEvent<HTMLSelectElement>);
        }}
      />
      {/* react-select's hidden input cannot be `required`; this one gives the browser something to validate. */}
      {required && <input tabIndex={-1} aria-hidden required value={current} onChange={() => undefined} style={{ position: "absolute", bottom: 0, left: 0, width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />}
    </div>
  );
}
