import CssBaseline from "@mui/material/CssBaseline";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import "home/css/index.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "./components/Dashboard";
import { LoginView } from "./components/LoginView";
import { ResetPasswordView } from "./components/ResetPasswordView";
import { LoginHandler } from "./login_handler/LoginHandler";
import { createLoginHandler } from "./utils";

export let loginHandler: LoginHandler;
const container = document.getElementById("root");
const root = createRoot(container!);

// Mirrors the CSS custom properties in home/css/index.css for the few MUI
// surfaces the dashboard still uses (Drawer, Menu, Switch, Snackbar, LoginView).
const theme = createTheme({
    palette: {
        mode: "dark",
        primary: { main: "#007acc" },
        background: { default: "#101519", paper: "#0b1014" },
        text: { primary: "#d5e8f4", secondary: "#c9d7e0" },
    },
    typography: {
        fontFamily: '"Rubik", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    },
    shape: { borderRadius: 7 },
});

const loginHandlerReadyCallback = () => {
    renderHomePage();
};
loginHandler = createLoginHandler(loginHandlerReadyCallback);

function passwordResetCode(): string | null {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") !== "resetPassword") return null;
    return params.get("oobCode");
}

function renderHomePage() {
    const resetCode = passwordResetCode();
    const authenticated = loginHandler.loginState() == "authenticated";
    document.title = resetCode
        ? "Reset password - Stretch Web Interface"
        : authenticated
          ? "Home - Stretch Web Interface"
          : "Login - Stretch Web Interface";

    root.render(
        <ThemeProvider theme={theme}>
            <CssBaseline />
            {resetCode ? (
                <ResetPasswordView code={resetCode} />
            ) : authenticated ? (
                <Dashboard />
            ) : (
                <LoginView />
            )}
        </ThemeProvider>,
    );
}
