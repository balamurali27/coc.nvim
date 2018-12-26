import os from 'os'
import fs from 'fs'
import path from 'path'
import { Emitter, Event, Disposable } from 'vscode-languageserver-protocol'
import Uri from 'vscode-uri'
import { ConfigurationChangeEvent, ConfigurationInspect, ConfigurationShape, ConfigurationTarget, ErrorItem, IConfigurationData, IConfigurationModel, WorkspaceConfiguration } from '../types'
import { deepClone, deepFreeze, mixin } from '../util/object'
import { watchFile, disposeAll } from '../util'
import { Configuration } from './configuration'
import { ConfigurationModel } from './model'
import { addToValueTree, loadDefaultConfigurations, parseContentFromFile, getChangedKeys } from './util'
import { objectLiteral } from '../util/is'
const logger = require('../util/logger')('configurations')

function lookUp(tree: any, key: string): any {
  if (key) {
    if (tree && tree.hasOwnProperty(key)) return tree[key]
    const parts = key.split('.')
    let node = tree
    for (let i = 0; node && i < parts.length; i++) {
      node = node[parts[i]]
    }
    return node
  }
  return tree
}

export default class Configurations {
  private _configuration: Configuration
  private _errorItems: ErrorItem[] = []
  private _folderConfigurations: Map<string, ConfigurationModel> = new Map()
  private _onError = new Emitter<ErrorItem[]>()
  private _onChange = new Emitter<ConfigurationChangeEvent>()
  private disposables: Disposable[] = []
  private workspaceConfigFile: string

  public readonly onError: Event<ErrorItem[]> = this._onError.event
  public readonly onDidChange: Event<ConfigurationChangeEvent> = this._onChange.event

  constructor(
    private userConfigFile?: string | null,
    private readonly _proxy?: ConfigurationShape
  ) {
    let user = parseContentFromFile(userConfigFile, this.handleErrors.bind(this))
    let data: IConfigurationData = {
      defaults: loadDefaultConfigurations(),
      user,
      workspace: { contents: {} }
    }
    this._configuration = Configurations.parse(data)
    this.watchFile(userConfigFile, ConfigurationTarget.User)
  }

  public get errorItems(): ErrorItem[] {
    return this._errorItems
  }

  public get foldConfigurations(): Map<string, ConfigurationModel> {
    return this._folderConfigurations
  }

  // used for extensions, not change event fired
  public extendsDefaults(props: { [key: string]: any }): void {
    let { defaults } = this._configuration
    let { contents } = defaults
    contents = deepClone(contents)
    Object.keys(props).forEach(key => {
      addToValueTree(contents, key, props[key], msg => {
        console.error(msg) // tslint:disable-line
      })
    })
    let data: IConfigurationData = {
      defaults: { contents },
      user: this._configuration.user,
      workspace: this._configuration.workspace
    }
    this._configuration = Configurations.parse(data)
  }

  // change user configuration, without change file
  public updateUserConfig(props: { [key: string]: any }): void {
    let { user } = this._configuration
    let model = user.clone()
    Object.keys(props).forEach(key => {
      let val = props[key]
      if (val === undefined) {
        model.removeValue(key)
      } else if (objectLiteral(val)) {
        for (let k of Object.keys(val)) {
          model.setValue(`${key}.${k}`, val[k])
        }
      } else {
        model.setValue(key, val)
      }
    })
    this.changeConfiguration(ConfigurationTarget.User, model)
  }

  public get defaults(): ConfigurationModel {
    return this._configuration.defaults
  }

  public get user(): ConfigurationModel {
    return this._configuration.user
  }

  public get workspace(): ConfigurationModel {
    return this._configuration.workspace
  }

  public addFolderFile(filepath: string): void {
    let { _folderConfigurations } = this
    if (_folderConfigurations.has(filepath)) return
    if (path.resolve(filepath, '../..') == os.homedir()) return
    let model = parseContentFromFile(filepath, this.handleErrors.bind(this))
    _folderConfigurations.set(filepath, new ConfigurationModel(model.contents))
    this.watchFile(filepath, ConfigurationTarget.Workspace)
    this.changeConfiguration(ConfigurationTarget.Workspace, model, filepath)
  }

  private watchFile(filepath: string, target: ConfigurationTarget): void {
    if (!fs.existsSync(filepath)) return
    if (global.hasOwnProperty('__TEST__')) return
    let disposable = watchFile(filepath, () => {
      let model = parseContentFromFile(filepath, this.handleErrors.bind(this))
      this.changeConfiguration(target, model, filepath)
    })
    this.disposables.push(disposable)
  }

  // create new configuration and fire change event
  public changeConfiguration(target: ConfigurationTarget, model: IConfigurationModel, configFile?: string): void {
    let { defaults, user, workspace } = this._configuration
    let { workspaceConfigFile } = this
    let data: IConfigurationData = {
      defaults: target == ConfigurationTarget.Global ? model : defaults,
      user: target == ConfigurationTarget.User ? model : user,
      workspace: target == ConfigurationTarget.Workspace ? model : workspace,
    }
    let configuration = Configurations.parse(data)
    let changed = getChangedKeys(this._configuration.getValue(), configuration.getValue())
    if (target == ConfigurationTarget.Workspace) this.workspaceConfigFile = configFile
    if (changed.length == 0) return
    this._configuration = configuration
    this._onChange.fire({
      affectsConfiguration: (section, resource) => {
        if (!resource || target != ConfigurationTarget.Workspace) return changed.indexOf(section) !== -1
        let u = Uri.parse(resource)
        if (u.scheme !== 'file') return changed.indexOf(section) !== -1
        let filepath = u.fsPath
        let preRoot = workspaceConfigFile ? path.resolve(workspaceConfigFile, '../..') : ''
        if (configFile && !filepath.startsWith(preRoot) && !filepath.startsWith(path.resolve(configFile, '../..'))) {
          return false
        }
        return changed.indexOf(section) !== -1
      }
    })
  }

  public setFolderConfiguration(uri: string): void {
    let u = Uri.parse(uri)
    if (u.scheme != 'file') return
    let filepath = u.fsPath
    for (let [configFile, model] of this.foldConfigurations) {
      let root = path.resolve(configFile, '../..')
      if (filepath.startsWith(root) && this.workspaceConfigFile != configFile) {
        this.changeConfiguration(ConfigurationTarget.Workspace, model, configFile)
        break
      }
    }
  }

  public hasFolderConfiguration(filepath: string): boolean {
    let { folders } = this
    return folders.findIndex(f => filepath.startsWith(f)) !== -1
  }

  public getConfigFile(target: ConfigurationTarget): string {
    if (target == ConfigurationTarget.Global) return null
    if (target == ConfigurationTarget.User) return this.userConfigFile
    return this.workspaceConfigFile
  }

  private get folders(): string[] {
    let res: string[] = []
    let { _folderConfigurations } = this
    for (let folder of _folderConfigurations.keys()) {
      res.push(path.resolve(folder, '../..'))
    }
    return res
  }

  public get configuration(): Configuration {
    return this._configuration
  }

  /**
   * getConfiguration
   *
   * @public
   * @param {string} section
   * @returns {WorkspaceConfiguration}
   */
  public getConfiguration(section?: string, resource?: string): WorkspaceConfiguration {
    let configuration: Configuration
    if (resource) {
      let { defaults, user } = this._configuration
      configuration = new Configuration(defaults, user, this.getFolderConfiguration(resource))
    } else {
      configuration = this._configuration
    }
    const config = Object.freeze(lookUp(configuration.getValue(null), section))

    const result: WorkspaceConfiguration = {
      has(key: string): boolean {
        return typeof lookUp(config, key) !== 'undefined'
      },
      get: <T>(key: string, defaultValue?: T) => {
        let result: T = lookUp(config, key)
        if (result == null) return defaultValue
        return result
      },
      update: (key: string, value: any, isUser = false) => {
        let s = section ? `${section}.${key}` : key
        if (!this.workspaceConfigFile) isUser = true
        let target = isUser ? ConfigurationTarget.User : ConfigurationTarget.Workspace
        let model = target == ConfigurationTarget.User ? this.user.clone() : this.workspace.clone()
        if (value == undefined) {
          model.removeValue(s)
        } else {
          model.setValue(s, value)
        }
        this.changeConfiguration(target, model, target == ConfigurationTarget.Workspace ? this.workspaceConfigFile : this.userConfigFile)
        if (this._proxy && !global.hasOwnProperty('__TEST__')) {
          if (value == undefined) {
            this._proxy.$removeConfigurationOption(target, s)
          } else {
            this._proxy.$updateConfigurationOption(target, s, value)
          }
        }
      },
      inspect: <T>(key: string): ConfigurationInspect<T> => {
        key = section ? `${section}.${key}` : key
        const config = this._configuration.inspect<T>(key)
        if (config) {
          return {
            key,
            defaultValue: config.default,
            globalValue: config.user,
            workspaceValue: config.workspace,
          }
        }
        return undefined
      }
    }
    Object.defineProperty(result, 'has', {
      enumerable: false
    })
    Object.defineProperty(result, 'get', {
      enumerable: false
    })
    Object.defineProperty(result, 'update', {
      enumerable: false
    })
    Object.defineProperty(result, 'inspect', {
      enumerable: false
    })

    if (typeof config === 'object') {
      mixin(result, config, false)
    }
    return deepFreeze(result) as WorkspaceConfiguration
  }

  private getFolderConfiguration(uri: string): ConfigurationModel {
    let u = Uri.parse(uri)
    if (u.scheme != 'file') return new ConfigurationModel()
    let filepath = u.fsPath
    for (let [configFile, model] of this.foldConfigurations) {
      let root = path.resolve(configFile, '../..')
      if (filepath.startsWith(root)) return model
    }
    return new ConfigurationModel()
  }

  private static parse(data: IConfigurationData): Configuration {
    const defaultConfiguration = new ConfigurationModel(data.defaults.contents)
    const userConfiguration = new ConfigurationModel(data.user.contents)
    const workspaceConfiguration = new ConfigurationModel(data.workspace.contents)
    return new Configuration(defaultConfiguration, userConfiguration, workspaceConfiguration, new ConfigurationModel())
  }

  private handleErrors(errors: ErrorItem[]): void {
    if (errors && errors.length) {
      this._errorItems.push(...errors)
      this._onError.fire(errors)
    }
  }

  public dispose(): void {
    disposeAll(this.disposables)
  }
}
