/**
 * The tag grammar a rail may be named with.
 *
 * A rail name becomes a URL path segment under /r/, so the same pattern is
 * enforced in three places: here for anything running on the robot or in CI,
 * `robots/$fleetId/build/rail` in database.rules.json, and RAIL in
 * src/pages/home/tsx/robotModel.ts. All three move together.
 */
const RELEASE_TAG = /^v\d+\.\d+\.\d+(-(alpha|beta|rc)\d+)?$/;

/**
 * Whether a string names a release the rails can serve.
 *
 * @param {string|null|undefined} tag Candidate tag.
 * @returns {boolean} True when the tag matches the release grammar.
 */
function isReleaseTag(tag) {
    return typeof tag === "string" && RELEASE_TAG.test(tag);
}

module.exports = { RELEASE_TAG, isReleaseTag };
