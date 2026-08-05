import "home/css/index.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { createLoginHandler } from "./utils";
import { LoginHandler } from "./login_handler/LoginHandler";
import { SideBySideView } from "./components/SideBySideView";
import { LoginView } from "./components/LoginView";

export let loginHandler: LoginHandler;
const container = document.getElementById("root");
const root = createRoot(container!);

const loginHandlerReadyCallback = () => {
    renderHomePage();
};
loginHandler = createLoginHandler(loginHandlerReadyCallback);

function renderHomePage() {
    loginHandler.loginState() == "authenticated"
        ? (document.title = "Home - Stretch4-Web-Interface")
        : (document.title = "Login - Stretch4-Web-Interface");

    loginHandler.loginState() == "authenticated"
        ? root.render(<SideBySideView />)
        : root.render(<LoginView />);
}
