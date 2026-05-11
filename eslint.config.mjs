import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import pluginPrettier from "eslint-plugin-prettier";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
    js.configs.recommended,
    {
        files: ["**/*.{js,jsx,ts,tsx}"],
        plugins: {
            react: pluginReact,
            "react-hooks": pluginReactHooks,
            prettier: pluginPrettier,
        },
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: "module",
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.jest,
                ...globals.amd,
            },
            parserOptions: {
                ecmaFeatures: {
                    jsx: true,
                },
            },
        },
        settings: {
            react: {
                version: "detect",
            },
        },
        rules: {
            ...pluginReact.configs.recommended.rules,
            ...pluginReactHooks.configs.recommended.rules,
            "prettier/prettier": ["error", {}, { usePrettierrc: true }],
            eqeqeq: "off",
            quotes: [
                "error",
                "double",
                { avoidEscape: true, allowTemplateLiterals: true },
            ],
        },
    },
    prettier,
];
