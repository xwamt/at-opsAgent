# Run your first playbook: routine inspection

`pb.inspection` (routine inspection) is the best playbook to start with: it is **read-only end to end**, walks a checklist item by item, and never touches production changes.

## 1. Start the inspection

Open the chat view, then either:

- Click [Pick a playbook](command:atOpsAgent.pickPlaybook) and choose **Routine inspection**;
- Or type `/playbook` in the composer and pick it from the overlay.

## 2. Watch the agent work

Once started, the agent works through the inspection checklist:

- It runs **read-only** checks through plugins like AT Terminal / AT Grafana (service status, disk, key metrics, recent alerts…).
- Every finding lands in the **evidence timeline**, with a three-state conclusion: **confirmed / hypothesis / pending**.
- The inspection discipline is "**unchecked ≠ healthy**": items that could not be verified are flagged explicitly instead of defaulting to green.

The first read-only tool call may ask for approval once — tick "don't ask again this session" to let further read-only checks through. Write / exec operations are unaffected and always require their own approval.

## 3. Review the results

- The timeline strip at the top of the chat summarizes each piece of evidence;
- For a full-screen review, open the [Ops board](command:atOpsAgent.openBoard) — filter by severity and browse the timeline grouped by date.

## Next steps

Once the inspection runs clean, try `pb.metric-anomaly` (metric anomaly diagnosis, also read-only), or use `pb.incident` (incident response) for real incidents — where every write / exec action passes the dual-gate approval.
