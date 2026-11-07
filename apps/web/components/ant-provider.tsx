"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider, theme } from "antd";

/** Ant Design theme tied to the CRM's own colours; follows the system light/dark setting and the page direction (Arabic = right to left). */
export function AntProvider({ children, rtl = false }: { children: ReactNode; rtl?: boolean }) {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(mq.matches && document.documentElement.dataset.theme !== "light");
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return (
    <AntdRegistry>
      <ConfigProvider direction={rtl ? "rtl" : "ltr"} theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { colorPrimary: dark ? "#818cf8" : "#4f46e5", borderRadius: 8, fontFamily: "inherit", colorBgBase: dark ? "#121a2e" : "#ffffff" } }}>
        {children}
      </ConfigProvider>
    </AntdRegistry>
  );
}
