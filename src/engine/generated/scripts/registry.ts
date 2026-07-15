// Public source placeholder. Import/build client profiles provide their own generated script registry at runtime.
import type { GeneratedScriptModule } from "../../src/director/Runtime";
import type { GeneratedScriptRecord } from "../../src/habbo/runtimeData";

type PublicGeneratedScriptRecord = GeneratedScriptRecord & {
  module: GeneratedScriptModule;
  castFile: string;
  memberNumber: number;
};

export const generatedScripts: PublicGeneratedScriptRecord[] = [];
