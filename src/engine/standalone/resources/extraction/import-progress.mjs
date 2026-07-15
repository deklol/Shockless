const PREFIX = "@shockless-tool-progress ";

export function createArtifactProgress(phase) {
  let outputFiles = 0;
  let outputBytes = 0;
  let lastEmittedFiles = 0;
  let lastEmittedAt = 0;

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && outputFiles - lastEmittedFiles < 1000 && now - lastEmittedAt < 500) return;
    lastEmittedFiles = outputFiles;
    lastEmittedAt = now;
    console.log(`${PREFIX}${JSON.stringify({ phase, outputFiles, outputBytes })}`);
  };

  return {
    record(bytes) {
      outputFiles += 1;
      outputBytes += Number(bytes) || 0;
      emit(false);
    },
    finish() {
      emit(true);
      return { outputFiles, outputBytes };
    },
  };
}
