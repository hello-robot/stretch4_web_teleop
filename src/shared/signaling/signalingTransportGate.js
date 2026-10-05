function createSignalingTransportGate() {
    let activeTransport = null;

    return {
        activate(transport) {
            if (activeTransport && activeTransport !== transport) {
                return false;
            }
            activeTransport = transport;
            return true;
        },
        accepts(transport) {
            return activeTransport === transport;
        },
        goodbye(transport) {
            if (activeTransport !== transport) return false;
            activeTransport = null;
            return true;
        },
        reset() {
            activeTransport = null;
        },
    };
}

module.exports = { createSignalingTransportGate };
