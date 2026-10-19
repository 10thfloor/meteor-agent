export const MISSION_FILE_TOOL_NAMES = Object.freeze([
  'list_mission_files', 'read_mission_file', 'manage_mission_files',
]);

export const missionFileAccess = (config) => config?.capabilities?.files !== false;
