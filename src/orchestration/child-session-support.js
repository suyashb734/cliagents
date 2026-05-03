'use strict';

function getChildSessionSupport(adapterName, capabilities = null) {
  const hasCapabilities = Boolean(capabilities && typeof capabilities === 'object');
  const supportsMultiTurn = hasCapabilities
    ? capabilities.supportsMultiTurn === true
    : ['codex-cli', 'claude-code', 'gemini-cli', 'qwen-cli', 'opencode-cli'].includes(adapterName);
  const supportsResume = hasCapabilities
    ? capabilities.supportsResume === true
    : ['claude-code', 'gemini-cli', 'qwen-cli', 'opencode-cli'].includes(adapterName);

  const ephemeralReady = supportsMultiTurn;
  let collaboratorReady = false;
  let continuityMode = 'stateless';
  let reason = null;

  if (!supportsMultiTurn) {
    reason = 'adapter does not advertise multi-turn child support';
  } else if (!supportsResume) {
    reason = 'adapter does not advertise provider-session resume support';
  } else if (adapterName === 'codex-cli') {
    reason = 'codex worker sends remain stateless in the current tmux child runtime';
  } else {
    collaboratorReady = true;
    continuityMode = 'provider_resume';
  }

  return {
    ephemeralReady,
    collaboratorReady,
    continuityMode,
    reason
  };
}

function isCollaboratorReadyAdapter(adapterName, capabilities = null) {
  return getChildSessionSupport(adapterName, capabilities).collaboratorReady === true;
}

module.exports = {
  getChildSessionSupport,
  isCollaboratorReadyAdapter
};
