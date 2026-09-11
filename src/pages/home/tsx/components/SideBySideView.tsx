import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Grid from "@mui/material/Grid2";
import Snackbar from "@mui/material/Snackbar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import "home/css/SideBySideView.css";
import React, { useState } from "react";
import { isBrowser, isTablet } from "react-device-detect";
import { loginHandler } from "../index";
import { CallRobotSelector } from "./CallRobotSelector";
import { UserMaps } from "./UserMaps";

export const SideBySideView = (props) => {
    const [openFailureToast, setOpenFailureToast] = useState(false);
    const [failureToastMessage, setfailureToastMessage] = useState("");
    const [selectedMap, setSelectedMap] = useState<string | null>(null);

    const handleLogout = () => {
        loginHandler.logout().catch((error) => {
            setfailureToastMessage(
                `Please contact Hello Robot Support. ERROR ${error.code}: ${error.message}`,
            );
            setOpenFailureToast(true);
        });
    };

    return isTablet || isBrowser ? (
        <Box sx={{ flexGrow: 1 }}>
            <AppBar position="static" color="transparent" elevation={0}>
                <Toolbar>
                    <Typography
                        variant="h4"
                        component="div"
                        sx={{ flexGrow: 1 }}
                    >
                        Stretch Web Interface
                    </Typography>
                    <Button color="inherit" onClick={handleLogout}>
                        Logout
                    </Button>
                </Toolbar>
            </AppBar>
            <Grid
                container
                rowSpacing={1}
                columnSpacing={{ lg: 4, xl: 5 }}
                className="sbs-container"
            >
                <Grid size={{ md: 12, lg: 6 }}>
                    <UserMaps
                        selectedMap={selectedMap}
                        onSelectMap={setSelectedMap}
                        style={{ height: "500px", maxHeight: "500px" }}
                    />
                </Grid>
                <Grid size={{ md: 12, lg: 6 }}>
                    <CallRobotSelector
                        selectedMap={selectedMap}
                        style={{ height: "500px", maxHeight: "500px" }}
                    />
                </Grid>
            </Grid>
            <Snackbar
                anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
                open={openFailureToast}
                message={failureToastMessage}
                ContentProps={{
                    sx: {
                        background: "red",
                    },
                }}
            />
        </Box>
    ) : (
        <Box sx={{ flexGrow: 1 }}>
            <AppBar position="static" color="transparent" elevation={0}>
                <Toolbar>
                    <Typography
                        variant="h4"
                        component="div"
                        sx={{ flexGrow: 1 }}
                    >
                        Stretch Web Interface
                    </Typography>
                    <Button color="inherit" onClick={handleLogout}>
                        Logout
                    </Button>
                </Toolbar>
            </AppBar>
            <Grid container spacing={2} className="sbs-container">
                <Grid size={12}>
                    <CallRobotSelector
                        selectedMap={selectedMap}
                        style={{ height: "500px", maxHeight: "500px" }}
                    />
                </Grid>
                <Grid size={12}>
                    <UserMaps
                        selectedMap={selectedMap}
                        onSelectMap={setSelectedMap}
                        style={{ height: "500px", maxHeight: "500px" }}
                    />
                </Grid>
            </Grid>
            <Snackbar
                anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
                open={openFailureToast}
                message={failureToastMessage}
                ContentProps={{
                    sx: {
                        background: "red",
                    },
                }}
            />
        </Box>
    );
};
