function reconcileAssignmentRecords(records, assignments) {
    return Object.fromEntries(
        Object.entries(assignments).flatMap(([robotId, isActive]) => {
            const record = records[robotId];
            return record
                ? [[robotId, { ...record, is_active: Boolean(isActive) }]]
                : [];
        }),
    );
}

module.exports = { reconcileAssignmentRecords };
