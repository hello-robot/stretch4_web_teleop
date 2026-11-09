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

/**
 * The build fields a checkout publishes to robots/<fleetId>/build.
 *
 * A describe carrying a commit count or -dirty names a commit no rail was cut
 * from, so rail is set only where the describe is exactly a release tag. A
 * build with no rail is still published: the lobby distinguishes a robot on an
 * unreleased checkout from one that has never reported a build at all, and it
 * can only do that if the unreleased case says so.
 *
 * @param {string|null|undefined} describe Output of git describe.
 * @returns {{describe: string, rail?: string}|null} Build fields, or null when
 *     there is no describe to publish.
 */
function buildFromDescribe(describe) {
    if (typeof describe !== "string") return null;
    const trimmed = describe.trim();
    if (!trimmed) return null;
    return isReleaseTag(trimmed)
        ? { describe: trimmed, rail: trimmed }
        : { describe: trimmed };
}

module.exports = { RELEASE_TAG, buildFromDescribe, isReleaseTag };
