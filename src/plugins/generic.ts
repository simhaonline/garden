import { exec } from "child-process-promise"
import { BuildResult, BuildStatus, ParseModuleParams, Plugin, TestModuleParams, TestResult } from "../types/plugin"
import { Module } from "../types/module"
import { spawn } from "../util"

export class GenericModuleHandler<T extends Module = Module> implements Plugin<T> {
  name = "generic"
  supportedModuleTypes = ["generic"]

  parseModule({ ctx, config }: ParseModuleParams<T>) {
    return <T>new Module(ctx, config)
  }

  async getModuleBuildStatus({ module }: { module: T }): Promise<BuildStatus> {
    // Each module handler should keep track of this for now. Defaults to return false if a build command is specified.
    return { ready: !module.config.build.command }
  }

  async buildModule({ module }: { module: T }): Promise<BuildResult> {
    // By default we run the specified build command in the module root, if any.
    // TODO: Keep track of which version has been built (needs local data store/cache).
    if (module.config.build.command) {
      const result = await exec(module.config.build.command, { cwd: module.getBuildPath() })

      return {
        module,
        fresh: true,
        buildLog: result.stdout
      }
    } else {
      return { module }
    }
  }

  async processDependencyResult(dependencyResult) {
    return // no-op
  }

  async testModule({ module, testSpec }: TestModuleParams<T>): Promise<TestResult> {
    const result = await spawn(testSpec.command[0], testSpec.command.slice(1), { cwd: module.path, ignoreError: true })

    return {
      success: result.code === 0,
      output: result.output,
    }
  }
}
