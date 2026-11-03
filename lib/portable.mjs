const META_KEYS = ['projects', 'settings', 'profile', 'inference', 'projectContexts', 'projectCategories', 'queueOrder', 'orderRevision', 'localEndpoint'];

// Explicit allowlist: provider credentials and process-local question handles
// are never part of the portable snapshot. Source content is private user data.
export function portableSnapshot(store) {
  return {
    format: 'command-lounge', version: 1, exportedAt: new Date().toISOString(),
    configuration: Object.fromEntries(META_KEYS.map(key => [key, store.getMeta(key)])),
    tasks: store.all().map(task => ({ ...task, status: (!task.external||task.runtimeProvider==='desktop') && ['running', 'waiting'].includes(task.status) ? 'paused' : task.status, pending: [], turnId: null, runtimeSessionId:undefined, observationReserved:false, sourceControlReserved:false,migrationReserved:false, ...(task.runtimeProvider==='desktop'?{desktopMonitoringPaused:true}:{}), routingContext: undefined })),
  };
}
