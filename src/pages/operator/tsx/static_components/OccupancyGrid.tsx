// Adapted from ros2djs and nav2djs

import React from "react";
import createjs from "createjs-module";
import { ROSOccupancyGrid, ROSPoint, ROSPose } from "shared/util";
import { Pose, Vector3, Quaternion, Transform } from "roslib";
import { MapFunctions } from "../layout_components/AutoNav";
import { FunctionProvider } from "../function_providers/FunctionProvider";
import hexToRgbArray from "../utils/hex-to-rgb-array";

/** Arrow size in map coords. */
const NAV_ARROW_GEOM_SIZE = 40;
/** Arrow size on screen (CSS px). */
const NAV_ARROW_SCREEN_PX = 32;
/** White border size around marker */
const NAV_ARROW_BORDER_WIDTH_PX = 5;
/** Same outline, in map coords. */
const NAV_ARROW_OUTLINE_LOCAL =
    (NAV_ARROW_GEOM_SIZE / NAV_ARROW_SCREEN_PX) * NAV_ARROW_BORDER_WIDTH_PX;
/** Saved-pose circle radius. */
const SAVED_POSE_RADIUS = 30;
/** Saved-pose diameter (for scaling). */
const SAVED_POSE_DIAMETER = SAVED_POSE_RADIUS * 2;
/** Saved-pose size on screen (CSS px). */
const SAVED_POSE_SCREEN_PX = 22;
/** Hover label font size in map coords. */
const LABEL_GEOM_SIZE = 40;
/** Hover label size on screen (CSS px). */
const LABEL_SCREEN_PX = 14;

type Point2 = { x: number; y: number };

/** DisplayObject that can store a base scale + optional pulse multiplier. */
type ScalableMarker = createjs.DisplayObject & {
    baseScaleX?: number;
    baseScaleY?: number;
    pulseFactor?: number;
};

/** Push each vertex outward from the centroid by `outlineLocal` (approx. outside outline). */
function expandVerticesOutward(
    vertices: Point2[],
    outlineLocal: number,
): Point2[] {
    const cx = vertices.reduce((sum, v) => sum + v.x, 0) / vertices.length;
    const cy = vertices.reduce((sum, v) => sum + v.y, 0) / vertices.length;
    return vertices.map((v) => {
        const dx = v.x - cx;
        const dy = v.y - cy;
        const len = Math.hypot(dx, dy) || 1;
        return {
            x: v.x + (dx / len) * outlineLocal,
            y: v.y + (dy / len) * outlineLocal,
        };
    });
}

/**
 * Append a closed rounded polygon path to a CreateJS Graphics object.
 */
function appendRoundedPolygon(
    graphics: createjs.Graphics,
    vertices: Point2[],
    cornerRadius: number,
) {
    const n = vertices.length;
    for (let i = 0; i < n; i++) {
        const curr = vertices[i];
        const prev = vertices[(i + n - 1) % n];
        const next = vertices[(i + 1) % n];
        const toPrev = { x: prev.x - curr.x, y: prev.y - curr.y };
        const toNext = { x: next.x - curr.x, y: next.y - curr.y };
        const lenPrev = Math.hypot(toPrev.x, toPrev.y);
        const lenNext = Math.hypot(toNext.x, toNext.y);
        const r = Math.min(cornerRadius, lenPrev / 2, lenNext / 2);
        const p1 = {
            x: curr.x + (toPrev.x / lenPrev) * r,
            y: curr.y + (toPrev.y / lenPrev) * r,
        };
        const p2 = {
            x: curr.x + (toNext.x / lenNext) * r,
            y: curr.y + (toNext.y / lenNext) * r,
        };
        if (i === 0) {
            graphics.moveTo(p1.x, p1.y);
        } else {
            graphics.lineTo(p1.x, p1.y);
        }
        graphics.quadraticCurveTo(curr.x, curr.y, p2.x, p2.y);
    }
    graphics.closePath();
}

/**
 * OccupancyGrid is a React component that manages the display and interaction
 * with a ROS occupancy grid map using createjs for rendering. It provides
 * methods for drawing pose markers, navigation arrows, and handling user
 * interactions for navigation goals.
 */
export class OccupancyGrid extends React.Component {
    // The createjs stage (canvas root)
    private rootObject: createjs.Stage;
    // The origin of the map in ROS coordinates
    private origin?: Pose;
    // The bitmap image of the occupancy grid
    private bitmap?: createjs.Bitmap;
    // Map dimensions in cells
    public width: number;
    public height: number;
    // Scaling factors for the map
    private scaleX?: number;
    private scaleY?: number;
    // The ROS occupancy grid data
    private map: ROSOccupancyGrid;
    // The createjs shape for the goal marker
    private goalMarker?: createjs.Shape;
    // The createjs shape for the robot's current pose
    private robotMarker?: createjs.Shape;
    // Fallback poll when amclPose events are sparse
    private setPoseInterval?: ReturnType<typeof setInterval>;
    // Unsubscribe from RemoteRobot map-pose listeners
    private mapPoseUnsubscribe?: () => void;
    // Re-apply marker scales when the canvas CSS size changes
    private resizeObserver?: ResizeObserver;
    // Goal-marker pulse tick handler (must be removable!)
    private goalPulseTick?: () => void;
    // List of saved pose markers (shapes and labels)
    private savedPoseMarkers: {
        circle: createjs.DisplayObject;
        label: createjs.Text;
    }[];
    // List of saved pose marker labels
    private savedPoseMarkersLabels: string[];
    // Map functions for interacting with the robot and map
    private functs: MapFunctions;
    // The current goal position in ROS coordinates
    private goal_position?: ROSPoint;

    // Listeners for goal_position changes
    private goalPositionListeners: ((pos: ROSPoint | undefined) => void)[] = [];

    /**
     * Constructor initializes the occupancy grid, sets up the canvas, and enables mouse/touch events.
     */
    constructor(props: { functs: MapFunctions; rootObject: createjs.Stage }) {
        super(props);
        this.rootObject = props.rootObject;
        this.rootObject.enableMouseOver();
        createjs.Touch.enable(this.rootObject);
        this.width = 0;
        this.height = 0;
        this.map = props.functs.GetMap;
        this.functs = props.functs;
        this.savedPoseMarkers = [];
        this.savedPoseMarkersLabels = [];
        this.createOccupancyGridClient();
    }

    /**
     * Helper method to calculate the scale of a marker based on
     * the desired screen size and the geometric size of the marker
     */
    private screenConstantScale(
        geomSize: number,
        desiredScreenPx: number,
    ): { scaleX: number; scaleY: number } {
        const canvas = this.rootObject.canvas as HTMLCanvasElement | undefined;
        const stageScaleX = this.rootObject.scaleX || 1;
        const stageScaleY = this.rootObject.scaleY || 1;
        const cssScaleX =
            canvas && canvas.width > 0 && canvas.clientWidth > 0
                ? canvas.clientWidth / canvas.width
                : 1;
        const cssScaleY =
            canvas && canvas.height > 0 && canvas.clientHeight > 0
                ? canvas.clientHeight / canvas.height
                : 1;
        return {
            scaleX: desiredScreenPx / (geomSize * stageScaleX * cssScaleX),
            scaleY: desiredScreenPx / (geomSize * stageScaleY * cssScaleY),
        };
    }

    /**
     * Apply screen-constant scale to a marker
     */
    private applyMarkerScreenScale(
        marker: ScalableMarker,
        geomSize: number,
        desiredScreenPx: number,
    ) {
        const { scaleX, scaleY } = this.screenConstantScale(
            geomSize,
            desiredScreenPx,
        );
        marker.baseScaleX = scaleX;
        marker.baseScaleY = scaleY;
        const pulse = marker.pulseFactor ?? 1;
        marker.scaleX = scaleX * pulse;
        marker.scaleY = scaleY * pulse;
    }

    /** Helper method to update marker size useful if screen is resized */
    public refreshMarkerScales() {
        if (this.robotMarker) {
            this.applyMarkerScreenScale(
                this.robotMarker,
                NAV_ARROW_GEOM_SIZE,
                NAV_ARROW_SCREEN_PX,
            );
        }
        if (this.goalMarker) {
            this.applyMarkerScreenScale(
                this.goalMarker,
                NAV_ARROW_GEOM_SIZE,
                NAV_ARROW_SCREEN_PX,
            );
        }
        this.savedPoseMarkers.forEach((marker) => {
            this.applyMarkerScreenScale(
                marker.circle,
                SAVED_POSE_DIAMETER,
                SAVED_POSE_SCREEN_PX,
            );
            this.applyMarkerScreenScale(
                marker.label,
                LABEL_GEOM_SIZE,
                LABEL_SCREEN_PX,
            );
        });
        this.rootObject.update();
    }

    /** Stop the goal pulse animation. */
    private stopGoalPulse() {
        if (!this.goalPulseTick) return;
        createjs.Ticker.removeEventListener("tick", this.goalPulseTick);
        this.goalPulseTick = undefined;
    }

    /**
     * Draws a saved pose marker (circle and label) at the given coordinates.
     * @param x X coordinate
     * @param y Y coordinate
     * @param color RGB color array
     * @param text Label text
     * @param rotation Optional rotation quaternion (SE2 transform support)
     */
    drawSavedPoseMarker(x: number, y: number, color: number[], text: string, rotation?: Quaternion) {
        var container = new createjs.Container();

        var circle = new createjs.Shape();

        var graphics = new createjs.Graphics();
        graphics.beginFill(
            createjs.Graphics.getRGB(color[0], color[1], color[2], 0.5),
        );
        graphics.drawCircle(0, 0, SAVED_POSE_RADIUS);
        graphics.endFill();

        createjs.Shape.call(circle, graphics);
        container.addChild(circle);

        if (rotation) {
            var arrow = new createjs.Shape();
            var arrowGraphics = new createjs.Graphics();
            var size = 20;
            var arrowColor = createjs.Graphics.getRGB(color[0], color[1], color[2], 0.9);
            arrowGraphics.beginFill(arrowColor);
            arrowGraphics.moveTo(0, size);
            arrowGraphics.lineTo(-size / 2, -size / 2);
            arrowGraphics.lineTo(size / 2, -size / 2);
            arrowGraphics.lineTo(0, size);
            arrowGraphics.closePath();
            arrowGraphics.endFill();
            createjs.Shape.call(arrow, arrowGraphics);

            let theta = this.rosQuaternionToGlobalTheta(rotation);
            arrow.rotation = theta - 90.0;
            container.addChild(arrow);
        }

        container.x = x;
        container.y = y;
        this.applyMarkerScreenScale(
            container,
            SAVED_POSE_DIAMETER,
            SAVED_POSE_SCREEN_PX,
        );

        var label = new createjs.Text(
            text,
            `bold ${LABEL_GEOM_SIZE}px Arial`,
            "#ff7700",
        );
        label.x = x;
        label.y = y - 10;
        label.textAlign = "center";
        this.applyMarkerScreenScale(label, LABEL_GEOM_SIZE, LABEL_SCREEN_PX);
        label.textBaseline = "alphabetic";

        container.on("mouseover", (event) => {
            label.visible = true;
        });
        container.on("mouseout", (event) => {
            label.visible = false;
        });
        return { circle: container, label };
    }

    /**
     * Draws a navigation arrow at the given location, optionally pulsing.
     * @param pulse Whether the arrow should pulse
     * @param color RGB color array
     */
    drawNavigationArrow(pulse: boolean, color: number[]) {
        var arrow = new createjs.Shape();
        var size = NAV_ARROW_GEOM_SIZE;
        var cornerRadius = 10;
        // Outside-only outline (CSS outline-like): larger white underlay, then fill on top.
        var outlineColor = createjs.Graphics.getRGB(255, 255, 255, 0.7);
        var fillColor = createjs.Graphics.getRGB(
            color[0],
            color[1],
            color[2],
            0.85,
        );

        // Tip / left / right — same geometry as before, with rounded corners.
        const vertices: Point2[] = [
            { x: 0.0, y: size / 1.5 },
            { x: -size / 2.0, y: -size / 2.0 },
            { x: size / 2.0, y: -size / 2.0 },
        ];
        const outlineVertices = expandVerticesOutward(
            vertices,
            NAV_ARROW_OUTLINE_LOCAL,
        );

        var graphics = new createjs.Graphics();
        graphics.beginFill(outlineColor);
        appendRoundedPolygon(
            graphics,
            outlineVertices,
            cornerRadius + NAV_ARROW_OUTLINE_LOCAL,
        );
        graphics.endFill();

        graphics.beginFill(fillColor);
        appendRoundedPolygon(graphics, vertices, cornerRadius);
        graphics.endFill();

        // create the shape
        createjs.Shape.call(arrow, graphics);

        const scalable = arrow as ScalableMarker;
        scalable.baseScaleX = 1;
        scalable.baseScaleY = 1;
        scalable.pulseFactor = 1;

        if (pulse) {
            this.stopGoalPulse();
            var growCount = 0;
            var growing = true;
            const onTick = () => {
                if (growing) {
                    scalable.pulseFactor = (scalable.pulseFactor ?? 1) * 1.035;
                    growing = ++growCount < 10;
                } else {
                    scalable.pulseFactor = (scalable.pulseFactor ?? 1) / 1.035;
                    growing = --growCount < 0;
                }
                scalable.scaleX =
                    (scalable.baseScaleX ?? 1) * (scalable.pulseFactor ?? 1);
                scalable.scaleY =
                    (scalable.baseScaleY ?? 1) * (scalable.pulseFactor ?? 1);
            };
            this.goalPulseTick = onTick;
            createjs.Ticker.addEventListener("tick", onTick);
        }
        return arrow;
    }

    /**
     * Creates the occupancy grid bitmap from
     * the ROS map data and adds it to the stage.
     */
    createOccupancyGridBitmap() {

        // Create an internal drawing canvas for the occupancy grid image
        var canvas = document.createElement("canvas");
        // Get the 2D drawing context, with willReadFrequently for performance
        var context = canvas!.getContext("2d", { willReadFrequently: true });

        // If the map is not available, display a placeholder rectangle and error text
        if (!this.map) {
            var rect = new createjs.Shape();
            rect.graphics.beginStroke("#000000");
            rect.graphics.setStrokeStyle(3);
            rect.graphics.drawRect(0, 0, 300, 500);
            rect.graphics.endStroke();
            var text = new createjs.Text("Could not load map", "30px Arial");
            text.x = 20;
            text.y = 250;
            this.rootObject.addChild(rect);
            this.rootObject.addChild(text);
            return;
        }

        // Save the map origin (position and orientation) from ROS map metadata
        this.origin = new Pose({
            position: this.map.info.origin.position,
            orientation: this.map.info.origin.orientation,
        });

        // Set the canvas size to match the map dimensions (in cells)
        this.width = this.map.info.width;
        this.height = this.map.info.height;
        canvas.width = this.width;
        canvas.height = this.height;

        // Create an ImageData object to hold the pixel data for the map
        var imageData = context!.createImageData(this.width, this.height);

        // Loop through each row of the map...
        for (var row = 0; row < this.height; row++) {
            // ...and for each column in the row
            for (var col = 0; col < this.width; col++) {

                // Calc index into the map data array.
                // NOTE: ROS maps are bottom-left origin.
                var mapI = col + (this.height - row - 1) * this.width;

                // Get the occupancy value for this cell
                var data = this.map.data[mapI];

                // Init RGB vars...
                var r: number;
                var g: number;
                var b: number;

                // Calc pixel color based on...
                if (data === 100) {
                    // ...occupied cells: rgb(71, 95, 111)
                    r = 71;
                    g = 95;
                    b = 111;
                } else if (data === 0) {
                    // ...free cells: rgb(241, 248, 253)
                    r = 241;
                    g = 248;
                    b = 253;
                } else {
                    // ...unknown cells: rgb(157, 197, 191)
                    r = 157;
                    g = 197;
                    b = 191;
                }

                // Calculate the index into the image data array (RGBA)
                var i = (col + row * this.width) * 4;

                // Set R, G, B channels to respective values, and alpha to 255 (opaque)
                imageData.data[i] = r;
                imageData.data[++i] = g;
                imageData.data[++i] = b;
                imageData.data[++i] = 255;
            }
        }

        // Draw the generated image data onto the canvas
        context!.putImageData(imageData, 0, 0);

        // Create a createjs.Bitmap from the canvas and add it to the stage
        this.bitmap = new createjs.Bitmap(canvas);
        this.rootObject.addChild(this.bitmap);

        // Set the scaling factors for converting between map and world coordinates
        this.scaleX = this.map.info.resolution;
        this.scaleY = this.map.info.resolution;
    }

    /**
     * Creates the occupancy grid by drawing the map data as vector rectangles using createjs.Shape.
     * It sets the origin, dimensions, and scaling factors for the map.
     */
    createOccupancyGridVector() {
        if (!this.map) {
            var rect = new createjs.Shape();
            rect.graphics.beginStroke("#000000");
            rect.graphics.setStrokeStyle(3);
            rect.graphics.drawRect(0, 0, 300, 500);
            rect.graphics.endStroke();
            var text = new createjs.Text("Could not load map", "30px Arial");
            text.x = 20;
            text.y = 250;
            this.rootObject.addChild(rect);
            this.rootObject.addChild(text);
            return;
        }

        this.origin = new Pose({
            position: this.map.info.origin.position,
            orientation: this.map.info.origin.orientation,
        });

        this.width = this.map.info.width;
        this.height = this.map.info.height;

        // Draw each cell as a vector rectangle
        for (let row = 0; row < this.height; row++) {
            for (let col = 0; col < this.width; col++) {
                let mapI = col + (this.height - row - 1) * this.width;
                let data = this.map.data[mapI];
                let color: string;
                if (data === 100) {
                    color = "#475F6F"; // occupied
                } else if (data === 0) {
                    color = "#F1F8FD"; // free
                } else {
                    color = "#9DC5BF"; // unknown
                }
                let cell = new createjs.Shape();
                cell.graphics.beginFill(color).drawRect(col, row, 1, 1);
                cell.graphics.endFill();
                this.rootObject.addChild(cell);
            }
        }

        this.scaleX = this.map.info.resolution;
        this.scaleY = this.map.info.resolution;
    }

    /**
     * Converts a ROS translation (Vector3) to global canvas coordinates.
     */
    rosToGlobal(translation: Vector3) {
        var x =
            (this.width * this.scaleX! -
                (-translation.x +
                    this.width * this.scaleX! +
                    this.origin!.position.x)) /
            this.scaleX!;
        var y =
            (-translation.y +
                this.height * this.scaleY! +
                this.origin!.position.y) /
            this.scaleY!;
        return {
            x: x,
            y: y,
        };
    }

    /**
     * Converts a ROS quaternion to a global theta (angle in degrees).
     * See: https://github.com/RobotWebTools/ros2djs/blob/develop/src/Ros2D.js#L34C1-L44C3
     */
    rosQuaternionToGlobalTheta(orientation: Quaternion) {
        // See https://en.wikipedia.org/wiki/Conversion_between_quaternions_and_Euler_angles#Rotation_matrices
        // here we use [x y z] = R * [1 0 0]
        var w = orientation.w;
        var x = orientation.x;
        var y = orientation.y;
        var z = orientation.z;
        // Canvas rotation is clock wise and in degrees
        return (
            (-Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) *
                180.0) /
            Math.PI
        );
    }

    /**
     * Converts global canvas coordinates to ROS coordinates.
     */
    globalToRos(x: number, y: number) {
        var rosX = (x / 5) * this.scaleX! + this.origin!.position.x;
        var rosY =
            (this.height - y / 5) * this.scaleY! + this.origin!.position.y;
        return {
            x: rosX,
            y: rosY,
            z: 0,
        } as ROSPoint;
    }

    /**
     * Apply a map pose to the robot marker (null-safe).
     */
    updateRobotMarker(pose?: Transform | null) {
        if (!this.robotMarker || !pose?.translation || !pose?.rotation) {
            return;
        }
        try {
            const globalCoord = this.rosToGlobal(pose.translation);
            this.robotMarker.x = globalCoord.x;
            this.robotMarker.y = globalCoord.y;
            const theta = this.rosQuaternionToGlobalTheta(pose.rotation);
            this.robotMarker.rotation = theta - 90.0;
            this.applyMarkerScreenScale(
                this.robotMarker,
                NAV_ARROW_GEOM_SIZE,
                NAV_ARROW_SCREEN_PX,
            );
            this.robotMarker.visible = true;
            // Keep the robot marker above goal / saved-pose markers.
            const top = this.rootObject.numChildren - 1;
            if (top >= 0) {
                this.rootObject.setChildIndex(this.robotMarker, top);
            }
            this.rootObject.update();
        } catch (err) {
            console.warn("updateRobotMarker failed:", err);
        }
    }

    private trySubscribeMapPoseUpdates() {
        if (this.mapPoseUnsubscribe) {
            return;
        }
        const unsubscribe = FunctionProvider.subscribeMapPose((pose) => {
            this.updateRobotMarker(pose);
        });
        if (!unsubscribe) {
            return;
        }
        this.mapPoseUnsubscribe = unsubscribe;
        this.updateRobotMarker(FunctionProvider.getMapPose());
    }

    /**
     * Adds a marker for the robot's current pose and updates it from amclPose
     * events (with a slow null-safe poll as backup).
     */
    addCurrentPoseMarker() {
        const color = hexToRgbArray("#008AE5");
        this.robotMarker = this.drawNavigationArrow(false, color);
        this.rootObject.addChild(this.robotMarker);

        this.trySubscribeMapPoseUpdates();
        this.setPoseInterval = setInterval(() => {
            this.trySubscribeMapPoseUpdates();
            try {
                const pose = this.functs.GetPose();
                this.updateRobotMarker(pose);
            } catch {
                // Pose may be unavailable before WebRTC map TF arrives.
            }
        }, 1000);
    }

    /**
     * Displays or hides pose markers for saved navigation goals.
     * @param display Whether to display the markers
     * @param poses Array of ROS transforms for each pose
     * @param poseNames Array of pose names
     * @param poseTypes Array of pose types
     */
    public displayPoseMarkers(
        display: boolean,
        poses: Transform[],
        poseNames: string[],
        poseTypes: string[],
    ) {
        if (!display) {
            this.savedPoseMarkers.forEach((marker) => {
                marker.circle.visible = false;
                marker.label.visible = false;
            });
        } else {
            // Re-draw or add pose markers
            poses.forEach((pose, index) => {
                // Recreate marker
                let globalCoord = this.rosToGlobal(pose.translation);
                let color = poseTypes[index] == "MAP" ? [0, 0, 255] : [255, 0, 0];
                var poseMarker = this.drawSavedPoseMarker(
                    globalCoord.x,
                    globalCoord.y,
                    color,
                    poseNames[index],
                    pose.rotation,
                );
                poseMarker.circle.visible = true;
                poseMarker.label.visible = false;

                var label_idx = this.savedPoseMarkersLabels.indexOf(
                    poseNames[index],
                );
                // If old pose marker label exists, overwrite marker
                if (label_idx !== -1) {
                    var oldPoseMarker = this.savedPoseMarkers[label_idx];
                    this.rootObject.removeChild(oldPoseMarker.circle);
                    this.rootObject.removeChild(oldPoseMarker.label);
                    this.savedPoseMarkers[label_idx] = poseMarker;
                    this.savedPoseMarkersLabels[label_idx] = poseNames[index];
                } else {
                    this.savedPoseMarkers.push(poseMarker);
                    this.savedPoseMarkersLabels.push(poseNames[index]);
                }

                this.rootObject.addChild(poseMarker.circle);
                this.rootObject.addChild(poseMarker.label);
            });
        }
        this.rootObject.update();
    }

    /**
     * Creates a goal marker at the given coordinates (in ROS or global space).
     * @param x X coordinate
     * @param y Y coordinate
     * @param ros Whether the coordinates are in ROS space
     */
    public createGoalMarker(x: number, y: number, ros: boolean, rotation?: Quaternion) {
        const color = hexToRgbArray('#2EE4C8');
        let globalCoord = { x: x, y: y };
        if (ros)
            globalCoord = this.rosToGlobal({
                x: x,
                y: y,
                z: 0,
            } as Vector3);
        // Preview / active goal draw only — do not poll GoalReached here
        // (that raced with FooterAutoNav and stole nav-complete events).
        if (this.goalMarker) {
            this.stopGoalPulse();
            this.rootObject.removeChild(this.goalMarker);
        }
        this.goalMarker = this.drawNavigationArrow(true, color);
        this.goalMarker.x = globalCoord.x;
        this.goalMarker.y = globalCoord.y;
        if (rotation) {
            let theta = this.rosQuaternionToGlobalTheta(rotation);
            this.goalMarker.rotation = theta - 90.0;
        }
        this.applyMarkerScreenScale(
            this.goalMarker,
            NAV_ARROW_GEOM_SIZE,
            NAV_ARROW_SCREEN_PX,
        );
        this.goalMarker.visible = true;
        this.rootObject.addChild(this.goalMarker);
        if (this.robotMarker) {
            const top = this.rootObject.numChildren - 1;
            if (top >= 0) {
                this.rootObject.setChildIndex(this.robotMarker, top);
            }
        }
        this.rootObject.update();
    }

    /**
     * Getter for the current goal_position.
     */
    goalPositionGet(): ROSPoint | undefined {
        return this.goal_position;
    }

    /**
     * Subscribe to changes in goal_position.
     * @param callback Function to call when goal_position changes
     */
    goalPositionSubscribe(callback: (pos: ROSPoint | undefined) => void): () => void {
        this.goalPositionListeners.push(callback);
        // Return an unsubscribe function
        // that's used in useEffect cleanup
        return () => {
            this.goalPositionListeners = this.goalPositionListeners.filter(cb => cb !== callback);
        };
    }

    /**
     * Setter for the current goal position.
     */
    goalPositionSet(pos: ROSPoint | undefined): void {
        this.goal_position = pos;
        this.goalPositionListeners.forEach(cb => cb(pos));
    }

    /**
     * Sends the robot to the current goal position, if set.
     */
    play() {
        if (this.goal_position) {
            this.functs.MoveBase({
                position: this.goal_position,
                orientation: { x: 0, y: 0, z: -0.45, w: 0.893 },
            } as ROSPose);
        }
        this.goalPositionSet(undefined);
        // this.functs.SetSelectGoal(false);
    }

    /**
     * Removes the current goal marker from the map.
     */
    removeGoalMarker() {
        this.goalPositionSet(undefined);
        if (this.goalMarker) {
            this.stopGoalPulse();
            this.rootObject.removeChild(this.goalMarker);
            this.goalMarker = undefined;
            this.rootObject.update();
        }
    }

    /** Tear down observers/timers/listeners owned by this map instance. */
    public dispose() {
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
        if (this.setPoseInterval) {
            clearInterval(this.setPoseInterval);
            this.setPoseInterval = undefined;
        }
        if (this.mapPoseUnsubscribe) {
            this.mapPoseUnsubscribe();
            this.mapPoseUnsubscribe = undefined;
        }
        this.stopGoalPulse();
        if (this.goalMarker) {
            this.rootObject.removeChild(this.goalMarker);
            this.goalMarker = undefined;
        }
    }

    /**
     * Initializes the occupancy grid, adds the robot pose marker, and sets up mouse event handlers.
     */
    createOccupancyGridClient() {

        this.createOccupancyGridBitmap();
        // this.createOccupancyGridVector();

        if (!this.map) return;

        this.addCurrentPoseMarker();

        const canvas = this.rootObject.canvas as HTMLCanvasElement | undefined;
        if (canvas && typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver(() => {
                this.refreshMarkerScales();
            });
            this.resizeObserver.observe(canvas);
        }

        this.rootObject.on("mousedown", (event) => {
            if (!this.functs.SelectGoal()) return
            else {
                let evt = event as createjs.MouseEvent;
                this.goalPositionSet(this.globalToRos(evt.stageX, evt.stageY));
                this.createGoalMarker(evt.stageX / 5, evt.stageY / 5, false);
            }
        });
    }
}
