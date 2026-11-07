"use client";

import { useEffect, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

const KEY = "reales-sidebar";

/** Collapses the sidebar to icons only and back. The choice is remembered in this browser (and applied before first paint by the inline script in the layout). */
export function SidebarToggle() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(document.documentElement.dataset.sidebar === "collapsed"); }, []);
  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    if (next) document.documentElement.dataset.sidebar = "collapsed"; else delete document.documentElement.dataset.sidebar;
    try { localStorage.setItem(KEY, next ? "collapsed" : "open"); } catch { /* storage unavailable: the toggle still works for this visit */ }
  }
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <button type="button" onClick={toggle} className="sidebar-toggle" aria-pressed={collapsed} aria-label={collapsed ? "Show sidebar names" : "Collapse sidebar to icons"} title={collapsed ? "Show names" : "Icons only"}>
      <Icon size={18} aria-hidden />
    </button>
  );
}
