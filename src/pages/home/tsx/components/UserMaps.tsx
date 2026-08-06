import { CardActionArea } from "@mui/material";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CardMedia from "@mui/material/CardMedia";
import Checkbox from "@mui/material/Checkbox";
import Grid from "@mui/material/Grid2";
import Typography from "@mui/material/Typography";
import React, { useEffect, useState } from "react";
import { loginHandler } from "../index";

interface UserMapsProps {
    selectedMap: string | null;
    onSelectMap: (mapId: string | null) => void;
    style?: React.CSSProperties;
}

export const UserMaps = ({ selectedMap, onSelectMap, style }: UserMapsProps) => {
    const [availableMaps, setAvailableMaps] = useState<any>({});

    useEffect(() => {
        if (loginHandler && loginHandler.getUserMaps) {
            // empty string robot uid fetches all accessible maps for the user
            loginHandler.getUserMaps("", (maps) => {
                setAvailableMaps(maps || {});
            });
        }
    }, []);

    const handleMapClick = (mapId: string) => {
        if (selectedMap === mapId) {
            onSelectMap(null); // Deselect if already selected
        } else {
            onSelectMap(mapId); // Select map
        }
    };

    return (
        <Box sx={{ flexGrow: 1, overflowY: "auto", padding: 2, ...style }}>
            <Typography variant="h5" component="h2" gutterBottom>
                Available Maps
            </Typography>
            {Object.keys(availableMaps).length === 0 ? (
                <Typography color="text.secondary">No maps available.</Typography>
            ) : (
                <Grid container spacing={2}>
                    {Object.entries(availableMaps).map(([mapId, mapInfo]: [string, any]) => (
                        <Grid size={{ xs: 12, sm: 6 }} key={mapId}>
                            <Card
                                sx={{
                                    border: selectedMap === mapId ? 2 : 1,
                                    borderColor: selectedMap === mapId ? 'primary.main' : 'grey.300',
                                    height: '100%',
                                    position: 'relative'
                                }}
                            >
                                <Checkbox
                                    checked={selectedMap === mapId}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={() => handleMapClick(mapId)}
                                    sx={{
                                        position: 'absolute',
                                        top: 8,
                                        right: 8,
                                        zIndex: 2,
                                        backgroundColor: 'rgba(255, 255, 255, 0.7)',
                                        '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.9)' }
                                    }}
                                />
                                <CardActionArea onClick={() => handleMapClick(mapId)} sx={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'flex-start' }}>
                                    {mapInfo.thumb_png_base64 ? (
                                        <CardMedia
                                            component="img"
                                            height="140"
                                            image={`data:image/png;base64,${mapInfo.thumb_png_base64}`}
                                            alt={mapInfo.name || mapId}
                                            sx={{ objectFit: 'contain', p: 1, backgroundColor: "#f5f5f5" }}
                                        />
                                    ) : (
                                        <Box sx={{ height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', backgroundColor: "#f5f5f5" }}>
                                            <Typography color="text.secondary">No preview</Typography>
                                        </Box>
                                    )}
                                    <CardContent>
                                        <Typography gutterBottom variant="h6" component="div" sx={{ fontSize: '1rem', wordBreak: 'break-word' }}>
                                            {mapInfo.name || mapId}
                                        </Typography>
                                    </CardContent>
                                </CardActionArea>
                            </Card>
                        </Grid>
                    ))}
                </Grid>
            )}
        </Box>
    );
};
