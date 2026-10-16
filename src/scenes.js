// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
//   - keep_door_locked: the door stays locked whatever its schedule
//     ("always locked"), e.g. when the alarm system is armed. Safe: allowed
//     without the remote unlock switch;
//   - end_lock_rule: back to the normal schedule. Ending "always locked" may
//     unlock the door: refused unless the remote unlock is enabled;
//   - unlock_door: one remote unlock (the door relocks after its usual
//     delay). Refused unless the remote unlock is enabled in the
//     configuration; it exists as a scene action only, never as a switch or
//     a dashboard button.
// A refusal throws: the scene logs it and goes on.
// -----------------------------------------------------------------------------

export const SCENE_ACTIONS = {
  async keep_door_locked(hub, { fields = {} }) {
    const door = await hub.keepLocked(fields.door, 'scene');
    return { door_name: door.name };
  },

  async end_lock_rule(hub, { fields = {} }) {
    const door = await hub.endRule(fields.door, 'scene');
    return { door_name: door.name };
  },

  async unlock_door(hub, { fields = {} }) {
    const door = await hub.unlock(fields.door, 'scene');
    return { door_name: door.name };
  },
};
