import CircleIcon from "@mui/icons-material/Circle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActions from "@mui/material/CardActions";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import { blue, green, grey, red, yellow } from "@mui/material/colors";
import Grid from "@mui/material/Grid2";
import Typography from "@mui/material/Typography";
import "home/css/CallRobotSelector.css";
import React, { useEffect, useState } from "react";
import { loginHandler } from "../index";

function get_indicator_text(status_str) {
    switch (status_str) {
        case "online":
            return "Online";
        case "standby":
            return "Standby (Ready to launch)";
        case "launching":
            return "Starting Interface...";
        case "offline":
            return "Offline";
        case "occupied":
            return "Occupied";
        default:
            return "Unknown";
    }
}

function get_indicator(status_str) {
    let statusui;
    switch (status_str) {
        case "active":
            statusui = {
                color_name: "green",
                color: green,
            };
            break;
        case "standby":
            statusui = {
                color_name: "blue",
                color: blue,
            };
            break;
        case "launching":
            statusui = {
                color_name: "yellow",
                color: yellow,
            };
            break;
        case "offline":
            statusui = {
                color_name: "red",
                color: red,
            };
            break;
        case "occupied":
            statusui = {
                color_name: "yellow",
                color: yellow,
            };
            break;
        default:
            statusui = {
                color_name: "grey",
                color: grey,
            };
    }
    let indicator_css = {
        fontSize: 12,
        color: statusui["color"]["A400"],
        animation: `glowing_${statusui["color_name"]} 3s linear infinite`,
    };
    indicator_css[`@keyframes glowing_${statusui["color_name"]}`] = {
        "0%": {
            color: statusui["color"]["A400"],
        },
        "50%": {
            color: statusui["color"]["A200"],
        },
        "100%": {
            color: statusui["color"]["A400"],
        },
    };
    return <CircleIcon sx={indicator_css} />;
}


function get_action(status_str: string, robot_name: string, robot_uid: string, selected_map: string | null) {
    const mapQuery = selected_map ? `&map=${encodeURIComponent(selected_map)}` : "";
    switch (status_str) {
        case "online":
            return (
                <Box sx={{ display: 'flex', gap: 1 }}>
                    <Button
                        href={`/operator/?robot=${robot_name}${mapQuery}`}
                        variant="contained"
                        color="success"
                        size="small"
                    >
                        Open Interface
                    </Button>
                    <Button
                        onClick={() => loginHandler.requestRobotStop(robot_uid)}
                        variant="outlined"
                        color="error"
                        size="small"
                    >
                        Stop Interface
                    </Button>
                </Box>
            );
        case "standby":
            return (
                <Button
                    onClick={() => loginHandler.requestRobotLaunch(robot_uid, selected_map)}
                    variant="contained"
                    color="primary"
                    size="small"
                >
                    Launch Interface
                </Button>
            );
        case "launching":
            return (
                <Button
                    variant="outlined"
                    size="small"
                    disabled
                    startIcon={<CircularProgress size={16} />}
                >
                    Launching...
                </Button>
            );
        case "occupied":
            return (
                <Box sx={{ display: 'flex', gap: 1 }}>
                    <Button
                        variant="contained"
                        size="small"
                        disabled
                    >
                        Occupied
                    </Button>
                    <Button
                        onClick={() => loginHandler.requestRobotStop(robot_uid)}
                        variant="outlined"
                        color="error"
                        size="small"
                    >
                        Stop Interface
                    </Button>
                </Box>
            );
        case "offline":
        default:
            return (
                <Button
                    variant="contained"
                    size="small"
                    disabled
                >
                    Offline
                </Button>
            );
    }
}

const CallRobotItem = (props: { uid: string; name: string; status: string; selectedMap: string | null }) => {
    return (
        <Card sx={{ minWidth: 275 }}>
            <CardContent>
                <Typography variant="h5" component="div">
                    {props.name}
                </Typography>
                <Typography sx={{ color: "text.secondary", mb: 1.5 }}>
                    {get_indicator(props.status)}{" "}
                    {get_indicator_text(props.status)}
                </Typography>
            </CardContent>
            <CardActions>{get_action(props.status, props.name, props.uid, props.selectedMap)}</CardActions>
        </Card>
    );
};

export const CallRobotSelector = (props: { selectedMap?: string | null; style?: React.CSSProperties }) => {
    const [callableRobots, setCallableRobots] = useState({});

    useEffect(() => {
        loginHandler.listRooms((robo_uid, robo_info) => {
            setCallableRobots((prev) => ({ ...prev, [robo_uid]: robo_info }));
        });
    }, [props]);

    return (
        <Box sx={{ flexGrow: 1 }}>
            <h2>Robots:</h2>
            <Grid
                container
                spacing={2}
                className="rs-container"
                style={props.style}
            >
                {Object.keys(callableRobots).length === 0 ? (
                    <Typography variant="body1" sx={{ color: "text.secondary", p: 2 }}>
                        No assigned robots found in Firebase Realtime Database for your account. Please check your <code>assignments/&lt;user_uid&gt;/robots</code> configuration in Firebase Console.
                    </Typography>
                ) : (
                    Object.entries(callableRobots).map(([robo_uid, value]: [string, any], idx) => {
                        if (value && value["is_active"]) {
                            return (
                                <Grid key={idx} size={{ md: 12, lg: 6 }}>
                                    <CallRobotItem
                                        key={idx}
                                        uid={robo_uid}
                                        name={value["name"] || robo_uid}
                                        status={value["status"] || "offline"}
                                        selectedMap={props.selectedMap || null}
                                    />
                                </Grid>
                            );
                        }
                        return null;
                    })
                )}
            </Grid>
        </Box>
    );
};

