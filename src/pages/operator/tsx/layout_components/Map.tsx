import React from "react";
import "latest-createjs";
import "operator/css/Map.css";

/**
 * Map component that displays a map for navigation.
 * It includes a back button to return to the previous view.
 *
 * @returns {JSX.Element} The rendered Map component.
 */

export const Map: React.FC = () =>
(
    <div className="mobile-map-container">
        <div id="map" />
    </div>
);
