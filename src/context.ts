/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { parse, relative, resolve } from "path"
import Bluebird = require("bluebird")
import { values, mapValues, fromPairs, toPairs } from "lodash"
import * as Joi from "joi"
import { Module, ModuleConfigType, TestSpec } from "./types/module"
import { ProjectConfig } from "./types/project"
import { getIgnorer, scanDirectory } from "./util"
import { DEFAULT_NAMESPACE, MODULE_CONFIG_FILENAME } from "./constants"
import { ConfigurationError, NotFoundError, ParameterError, PluginError } from "./exceptions"
import { VcsHandler } from "./vcs/base"
import { GitHandler } from "./vcs/git"
import { BuildDir } from "./build-dir"
import { Task, TaskGraph, TaskResults } from "./task-graph"
import { getLogger, LogEntry, RootLogNode } from "./logger"
import {
  BuildStatus,
  pluginActionNames,
  PluginActions,
  PluginFactory,
  Plugin,
  BuildResult,
  TestResult,
  ExecInServiceResult,
  DeleteConfigResult,
} from "./types/plugin"
import { GenericModuleHandler } from "./plugins/generic"
import { Environment, joiIdentifier, PrimitiveMap } from "./types/common"
import { Service, ServiceContext, ServiceStatus } from "./types/service"
import { TemplateStringContext, getTemplateContext, resolveTemplateStrings } from "./template-string"
import { EntryStyle } from "./logger/types"
import { loadConfig } from "./types/config"

export interface ModuleMap<T extends Module> { [key: string]: T }
export interface ServiceMap { [key: string]: Service<any> }
export interface ActionHandlerMap<T extends keyof PluginActions<any>> { [key: string]: PluginActions<any>[T] }

export type PluginActionMap = {
  [A in keyof PluginActions<any>]: {
    [pluginName: string]: PluginActions<any>[A],
  }
}

export interface ContextOpts {
  logger?: RootLogNode,
  plugins?: PluginFactory[],
}

const builtinPlugins: PluginFactory[] = [
  () => new GenericModuleHandler(),
]

export class GardenContext {
  public buildDir: BuildDir
  public readonly log: RootLogNode
  public readonly actionHandlers: PluginActionMap
  public readonly projectName: string
  public readonly plugins: { [key: string]: Plugin<any> }

  // TODO: We may want to use the _ prefix for private properties even if it's not idiomatic TS,
  // because we're supporting plain-JS plugins as well.
  private environment: string
  private namespace: string
  private readonly modules: ModuleMap<any>
  private modulesScanned: boolean
  private readonly services: ServiceMap
  private taskGraph: TaskGraph
  private readonly configKeyNamespaces: string[]

  vcs: VcsHandler

  constructor(
    public projectRoot: string, public projectConfig: ProjectConfig, logger?: RootLogNode,
  ) {
    this.modulesScanned = false
    this.log = logger || getLogger()
    // TODO: Support other VCS options.
    this.vcs = new GitHandler(this)
    this.taskGraph = new TaskGraph(this)
    this.buildDir = new BuildDir(this)

    this.modules = {}
    this.services = {}
    this.plugins = {}
    this.actionHandlers = <PluginActionMap>fromPairs(pluginActionNames.map(n => [n, {}]))

    this.buildDir.init()

    this.projectConfig = projectConfig
    this.projectName = this.projectConfig.name

    this.configKeyNamespaces = ["project"]

    this.setEnvironment(this.projectConfig.defaultEnvironment)
  }

  static async factory(projectRoot: string, { logger, plugins = [] }: ContextOpts = {}) {
    // const localConfig = new LocalConfig(projectRoot)
    const templateContext = await getTemplateContext()
    const config = await resolveTemplateStrings(await loadConfig(projectRoot), templateContext)
    const projectConfig = config.project

    if (!projectConfig) {
      throw new ConfigurationError(`Path ${projectRoot} does not contain a project configuration`, {
        projectRoot,
        config,
      })
    }

    const ctx = new GardenContext(projectRoot, projectConfig, logger)

    // Load configured plugins
    plugins = builtinPlugins.concat(plugins)

    for (const plugin of plugins) {
      ctx.registerPlugin(plugin)
    }

    // validate the provider configuration
    for (const envName in projectConfig.environments) {
      const envConfig = projectConfig.environments[envName]

      for (const providerName in envConfig.providers) {
        const providerConfig = envConfig.providers[providerName]
        const providerType = providerConfig.type

        if (!ctx.plugins[providerType]) {
          throw new ConfigurationError(
            `Could not find plugin type ${providerType} (specified in environment ${envName})`,
            { envName, providerType },
          )
        }
      }
    }

    return ctx
  }

  setEnvironment(environment: string) {
    const parts = environment.split(".")
    const name = parts[0]
    const namespace = parts.slice(1).join(".") || DEFAULT_NAMESPACE

    if (!this.projectConfig.environments[name]) {
      throw new ParameterError(`Could not find environment ${environment}`, {
        name,
        namespace,
      })
    }

    if (namespace.startsWith("garden-")) {
      throw new ParameterError(`Namespace cannot start with "garden-"`, {
        name,
        namespace,
      })
    }

    this.environment = name
    this.namespace = namespace

    return { name, namespace }
  }

  getEnvironment(): Environment {
    if (!this.environment) {
      throw new PluginError(`Environment has not been set`, {})
    }

    return {
      name: this.environment,
      namespace: this.namespace,
      config: this.projectConfig.environments[this.environment],
    }
  }

  async addTask(task: Task) {
    await this.taskGraph.addTask(task)
  }

  async processTasks(): Promise<TaskResults> {
    return this.taskGraph.processTasks()
  }

  registerPlugin(pluginFactory: PluginFactory) {
    const plugin = pluginFactory(this)
    const pluginName = Joi.attempt(plugin.name, joiIdentifier())

    if (this.plugins[pluginName]) {
      throw new ConfigurationError(`Plugin ${pluginName} declared more than once`, {
        previous: this.plugins[pluginName],
        adding: plugin,
      })
    }

    this.plugins[pluginName] = plugin

    for (const action of pluginActionNames) {
      const actionHandler = plugin[action]

      if (actionHandler) {
        const wrapped = (...args) => {
          return actionHandler.apply(plugin, args)
        }
        wrapped["actionType"] = action
        wrapped["pluginName"] = pluginName
        this.actionHandlers[action][pluginName] = wrapped
      }
    }
  }

  /*
    Returns all modules that are registered in this context.
    Scans for modules in the project root if it hasn't already been done.
   */
  async getModules(names?: string[], noScan?: boolean) {
    if (!this.modulesScanned && !noScan) {
      await this.scanModules()
    }

    if (!names) {
      return this.modules
    }

    const output = {}
    const missing: string[] = []

    for (const name of names) {
      const module = this.modules[name]

      if (!module) {
        missing.push(name)
      } else {
        output[name] = module
      }
    }

    if (missing.length) {
      throw new ParameterError(`Could not find module(s): ${missing.join(", ")}`, {
        missing,
        available: Object.keys(this.modules),
      })
    }

    return output
  }

  /*
    Returns all services that are registered in this context.
    Scans for modules and services in the project root if it hasn't already been done.
   */
  async getServices(names?: string[], noScan?: boolean): Promise<ServiceMap> {
    // TODO: deduplicate (this is almost the same as getModules()
    if (!this.modulesScanned && !noScan) {
      await this.scanModules()
    }

    if (!names) {
      return this.services
    }

    const output = {}
    const missing: string[] = []

    for (const name of names) {
      const module = this.services[name]

      if (!module) {
        missing.push(name)
      } else {
        output[name] = module
      }
    }

    if (missing.length) {
      throw new ParameterError(`Could not find service(s): ${missing.join(", ")}`, {
        missing,
        available: Object.keys(this.services),
      })
    }

    return output
  }

  /**
   * Returns the service with the specified name. Throws error if it doesn't exist.
   */
  async getService(name: string, noScan?: boolean): Promise<Service<any>> {
    return (await this.getServices([name], noScan))[name]
  }

  /*
    Scans the project root for modules and adds them to the context
   */
  async scanModules() {
    const ignorer = getIgnorer(this.projectRoot)
    const scanOpts = {
      filter: (path) => {
        const relPath = relative(this.projectRoot, path)
        return !ignorer.ignores(relPath)
      },
    }
    const modulePaths: string[] = []

    for await (const item of scanDirectory(this.projectRoot, scanOpts)) {
      const parsedPath = parse(item.path)

      if (parsedPath.base !== MODULE_CONFIG_FILENAME) {
        continue
      }

      modulePaths.push(parsedPath.dir)
    }

    for (const path of modulePaths) {
      const module = await this.resolveModule(path)
      module && await this.addModule(module)
    }

    this.modulesScanned = true
  }

  /*
    Adds the specified module to the context

    @param force - add the module again, even if it's already registered
   */
  async addModule(module: Module, force = false) {
    const config = await module.getConfig()

    if (!force && this.modules[config.name]) {
      const pathA = relative(this.projectRoot, this.modules[config.name].path)
      const pathB = relative(this.projectRoot, module.path)

      throw new ConfigurationError(
        `Module ${config.name} is declared multiple times ('${pathA}' and '${pathB}')`,
        { pathA, pathB },
      )
    }

    this.modules[config.name] = module

    // Add to service-module map
    for (const serviceName in config.services || {}) {
      if (!force && this.services[serviceName]) {
        throw new ConfigurationError(
          `Service names must be unique - ${serviceName} is declared multiple times ` +
          `(in '${this.services[serviceName].module.name}' and '${config.name}')`,
          {
            serviceName,
            moduleA: this.services[serviceName].module.name,
            moduleB: config.name,
          },
        )
      }

      this.services[serviceName] = await Service.factory(this, module, serviceName)
    }
  }

  /*
    Maps the provided name or locator to a Module. We first look for a module in the
    project with the provided name. If it does not exist, we treat it as a path
    (resolved with the project path as a base path) and attempt to load the module
    from there.

    // TODO: support git URLs
   */
  async resolveModule<T extends Module = Module>(nameOrLocation: string): Promise<T | null> {
    const parsedPath = parse(nameOrLocation)

    if (parsedPath.dir === "") {
      // Looks like a name
      const module = this.modules[nameOrLocation]

      if (!module) {
        throw new ConfigurationError(`Module ${nameOrLocation} could not be found`, {
          name: nameOrLocation,
        })
      }

      return <T>module
    }

    // Looks like a path
    const path = resolve(this.projectRoot, nameOrLocation)
    const config = await loadConfig(path)
    const moduleConfig = <ModuleConfigType<T>>config.module

    if (!moduleConfig) {
      return null
    }

    const parseHandler = this.getActionHandler("parseModule", moduleConfig.type)
    return parseHandler({ ctx: this, config: moduleConfig })
  }

  async getTemplateContext(extraContext: TemplateStringContext = {}): Promise<TemplateStringContext> {
    const env = this.getEnvironment()
    const _this = this

    return {
      ...await getTemplateContext(),
      config: async (key: string[]) => {
        return _this.getConfig(key)
      },
      variables: this.projectConfig.variables,
      environment: { name: env.name, config: <any>env.config },
      ...extraContext,
    }
  }

  //===========================================================================
  //region Plugin actions
  //===========================================================================

  async getModuleBuildPath<T extends Module>(module: T): Promise<string> {
    return await this.buildDir.buildPath(module)
  }

  async getModuleBuildStatus<T extends Module>(module: T): Promise<BuildStatus> {
    const defaultHandler = this.actionHandlers["getModuleBuildStatus"]["generic"]
    const handler = this.getActionHandler("getModuleBuildStatus", module.type, defaultHandler)
    return handler({ ctx: this, module })
  }

  async buildModule<T extends Module>(module: T, logEntry?: LogEntry): Promise<BuildResult> {
    await this.buildDir.syncDependencyProducts(module)
    const defaultHandler = this.actionHandlers["buildModule"]["generic"]
    const handler = this.getActionHandler("buildModule", module.type, defaultHandler)
    return handler({ ctx: this, module, logEntry })
  }

  async testModule<T extends Module>(module: T, testSpec: TestSpec, logEntry?: LogEntry): Promise<TestResult> {
    const defaultHandler = this.actionHandlers["testModule"]["generic"]
    const handler = this.getEnvActionHandler("testModule", module.type, defaultHandler)
    const env = this.getEnvironment()
    return handler({ ctx: this, module, testSpec, env, logEntry })
  }

  async getTestResult<T extends Module>(module: T, version: string, logEntry?: LogEntry): Promise<TestResult | null> {
    const handler = this.getEnvActionHandler("getTestResult", module.type, async () => null)
    const env = this.getEnvironment()
    return handler({ ctx: this, module, version, env, logEntry })
  }

  async getEnvironmentStatus() {
    const handlers = this.getEnvActionHandlers("getEnvironmentStatus")
    const env = this.getEnvironment()
    return Bluebird.props(mapValues(handlers, h => h({ ctx: this, env })))
  }

  async configureEnvironment() {
    const handlers = this.getEnvActionHandlers("configureEnvironment")
    const env = this.getEnvironment()
    const _this = this

    await Bluebird.each(toPairs(handlers), async ([name, handler]) => {
      const logEntry = _this.log.info({
        entryStyle: EntryStyle.activity,
        section: name,
        msg: "Configuring...",
      })

      await handler({ ctx: this, env, logEntry })

      logEntry.setSuccess({ msg: "Configured" })
    })
    return this.getEnvironmentStatus()
  }

  async getServiceStatus<T extends Module>(service: Service<T>): Promise<ServiceStatus> {
    const handler = this.getEnvActionHandler("getServiceStatus", service.module.type)
    return handler({ ctx: this, service, env: this.getEnvironment() })
  }

  async deployService<T extends Module>(service: Service<T>, serviceContext?: ServiceContext, logEntry?: LogEntry) {
    const handler = this.getEnvActionHandler("deployService", service.module.type)

    if (!serviceContext) {
      serviceContext = { envVars: {}, dependencies: {} }
    }

    return handler({ ctx: this, service, serviceContext, env: this.getEnvironment(), logEntry })
  }

  async getServiceOutputs<T extends Module>(service: Service<T>): Promise<PrimitiveMap> {
    // TODO: We might want to generally allow for "default handlers"
    let handler: PluginActions<T>["getServiceOutputs"]
    try {
      handler = this.getEnvActionHandler("getServiceOutputs", service.module.type)
    } catch (err) {
      return {}
    }
    return handler({ ctx: this, service, env: this.getEnvironment() })
  }

  async execInService<T extends Module>(service: Service<T>, command: string[]): Promise<ExecInServiceResult> {
    const handler = this.getEnvActionHandler("execInService", service.module.type)
    return handler({ ctx: this, service, command, env: this.getEnvironment() })
  }

  async getConfig(key: string[]): Promise<string> {
    this.validateConfigKey(key)
    // TODO: allow specifying which provider to use for configs
    const handler = this.getEnvActionHandler("getConfig")
    const value = await handler({ ctx: this, key, env: this.getEnvironment() })

    if (value === null) {
      throw new NotFoundError(`Could not find config key ${key}`, { key })
    } else {
      return value
    }
  }

  async setConfig(key: string[], value: string) {
    this.validateConfigKey(key)
    const handler = this.getEnvActionHandler("setConfig")
    return handler({ ctx: this, key, value, env: this.getEnvironment() })
  }

  async deleteConfig(key: string[]): Promise<DeleteConfigResult> {
    this.validateConfigKey(key)
    const handler = this.getEnvActionHandler("deleteConfig")
    const res = await handler({ ctx: this, key, env: this.getEnvironment() })

    if (!res.found) {
      throw new NotFoundError(`Could not find config key ${key}`, { key })
    } else {
      return res
    }
  }

  //endregion

  //===========================================================================
  //region Internal helpers
  //===========================================================================

  /**
   * Get a list of all available plugins (not specific to an environment).
   *
   * Optionally filter to only include plugins that support a specific module type.
   */
  private getAllPlugins(moduleType?: string): Plugin<any>[] {
    const allPlugins = values(this.plugins)

    if (moduleType) {
      return allPlugins.filter(p => p.supportedModuleTypes.includes(moduleType))
    } else {
      return allPlugins
    }
  }

  /**
   * Get a list of all configured plugins for the currently set environment.
   * Includes built-in module handlers (used for builds and such).
   *
   * Optionally filter to only include plugins that support a specific module type.
   */
  private getEnvPlugins(moduleType?: string) {
    const env = this.getEnvironment()
    const allPlugins = this.getAllPlugins(moduleType)
    const envProviderTypes = values(env.config.providers).map(p => p.type)

    return allPlugins.filter(p => envProviderTypes.includes(p.name))
  }

  /**
   * Get a handler for the specified action (and optionally module type).
   */
  public getActionHandlers
    <T extends keyof PluginActions<any>>(type: T, moduleType?: string): ActionHandlerMap<T> {

    const handlers: ActionHandlerMap<T> = {}

    this.getAllPlugins(moduleType)
      .filter(p => !!p[type])
      .map(p => {
        handlers[p.name] = this.actionHandlers[type][p.name]
      })

    return handlers
  }

  /**
   * Get the last configured handler for the specified action (and optionally module type).
   */
  public getActionHandler<T extends keyof PluginActions<any>>(
    type: T, moduleType?: string, defaultHandler?: PluginActions<any>[T],
  ): PluginActions<any>[T] {

    const handlers = values(this.getActionHandlers(type, moduleType))

    if (handlers.length) {
      return handlers[handlers.length - 1]
    } else if (defaultHandler) {
      return defaultHandler
    }

    // TODO: Make these error messages nicer
    let msg = `No handler for ${type} configured`

    if (moduleType) {
      msg += ` for module type ${moduleType}`
    }

    throw new ParameterError(msg, {
      requestedHandlerType: type,
      requestedModuleType: moduleType,
    })
  }

  /**
   * Get all handlers for the specified action for the currently set environment
   * (and optionally module type).
   */
  public getEnvActionHandlers
    <T extends keyof PluginActions<any>>(type: T, moduleType?: string): ActionHandlerMap<T> {

    const handlers: ActionHandlerMap<T> = {}

    this.getEnvPlugins(moduleType)
      .filter(p => !!p[type])
      .map(p => {
        handlers[p.name] = this.actionHandlers[type][p.name]
      })

    return handlers
  }

  /**
   * Get last configured handler for the specified action for the currently set environment
   * (and optionally module type).
   */
  public getEnvActionHandler<T extends keyof PluginActions<any>>(
    type: T, moduleType?: string, defaultHandler?: PluginActions<any>[T],
  ): PluginActions<any>[T] {

    const handlers = values(this.getEnvActionHandlers(type, moduleType))

    if (handlers.length) {
      return handlers[handlers.length - 1]
    } else if (defaultHandler) {
      return defaultHandler
    }

    const env = this.getEnvironment()
    let msg = `No handler for ${type} configured for environment ${env.name}`

    if (moduleType) {
      msg += ` and module type ${moduleType}`
    }

    throw new ParameterError(msg, {
      requestedHandlerType: type,
      requestedModuleType: moduleType,
      environment: env.name,
    })
  }

  /**
   * Validates the specified config key, making sure it's properly formatted and matches defined keys.
   */
  private validateConfigKey(key: string[]) {
    try {
      Joi.attempt(key, Joi.array().items(joiIdentifier()))
    } catch (err) {
      throw new ParameterError(
        `Invalid config key: ${key.join(".")} (must be a dot delimited string of identifiers)`,
        { key },
      )
    }

    if (!this.configKeyNamespaces.includes(key[0])) {
      throw new ParameterError(
        `Invalid config key namespace ${key[0]} (must be one of ${this.configKeyNamespaces.join(", ")})`,
        { key, validNamespaces: this.configKeyNamespaces },
      )
    }

    if (key[0] === "project") {
      // we allow any custom key under the project namespace
      return
    } else {
      // TODO: validate built-in (garden) and plugin config keys
    }
  }

  //endregion
}