function createRosReconnectGuard() {
    let intentionalClosePending = false;

    return {
        beginIntentionalClose() {
            intentionalClosePending = true;
        },
        cancelIntentionalClose() {
            intentionalClosePending = false;
        },
        shouldReconnectAfterClose() {
            if (!intentionalClosePending) return true;
            intentionalClosePending = false;
            return false;
        },
    };
}

module.exports = { createRosReconnectGuard };
