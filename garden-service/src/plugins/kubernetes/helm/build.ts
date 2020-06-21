/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { remove } from "fs-extra"
import { HelmModule } from "./config"
import { containsBuildSource, getChartPath, getBaseModule } from "./common"
import { helm } from "./helm-cli"
import { ConfigurationError } from "../../../exceptions"
import { deline } from "../../../util/string"
import { LogEntry } from "../../../logger/log-entry"
import { KubernetesPluginContext } from "../config"
import { BuildModuleParams, BuildResult } from "../../../types/plugin/module/build"

export async function buildHelmModule({ ctx, module, log }: BuildModuleParams<HelmModule>): Promise<BuildResult> {
  const k8sCtx = <KubernetesPluginContext>ctx
  const baseModule = getBaseModule(module)

  if (!baseModule && !(await containsBuildSource(module))) {
    if (!module.spec.chart) {
      throw new ConfigurationError(
        deline`Module '${module.name}' neither specifies a chart name, base module,
        nor contains chart sources at \`chartPath\`.`,
        { module }
      )
    }
    log.debug("Fetching chart...")
    try {
      await fetchChart(k8sCtx, log, module)
    } catch {
      // Update the local helm repos and retry
      log.debug("Updating Helm repos...")
      // The stable repo is no longer added by default
      await helm({
        ctx: k8sCtx,
        log,
        args: ["repo", "add", "stable", "https://kubernetes-charts.storage.googleapis.com/"],
      })
      await helm({ ctx: k8sCtx, log, args: ["repo", "update"] })
      log.debug("Fetching chart (after updating)...")
      await fetchChart(k8sCtx, log, module)
    }
  }

  return { fresh: true }
}

async function fetchChart(ctx: KubernetesPluginContext, log: LogEntry, module: HelmModule) {
  const buildPath = module.buildPath

  await remove(await getChartPath(module))

  const fetchArgs = ["fetch", module.spec.chart!, "--destination", buildPath, "--untar"]
  if (module.spec.version) {
    fetchArgs.push("--version", module.spec.version)
  }
  if (module.spec.repo) {
    fetchArgs.push("--repo", module.spec.repo)
  }
  await helm({ ctx, log, args: [...fetchArgs] })
}
