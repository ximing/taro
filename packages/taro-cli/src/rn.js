const fs = require('fs-extra')
const path = require('path')
const {performance} = require('perf_hooks')
const chokidar = require('chokidar')
const chalk = require('chalk')
const ejs = require('ejs')
const _ = require('lodash')
const shelljs = require('shelljs')
const klaw = require('klaw')

const Util = require('./util')
const child_process = require('child_process') // eslint-disable-line
const execSync = require('child_process').execSync
const CONFIG = require('./config')
const {getPkgVersion} = require('./util')
const StyleProcess = require('./rn/styleProcess')
const {transformJSCode} = require('./rn/transformJS')

const appPath = process.cwd()
const projectConfig = require(path.join(appPath, Util.PROJECT_CONFIG))(_.merge)
const sourceDirName = projectConfig.sourceRoot || CONFIG.SOURCE_DIR
const sourceDir = path.join(appPath, sourceDirName)
const tempDir = '.rn_temp'
const tempPath = path.join(appPath, tempDir)
const entryFilePath = Util.resolveScriptPath(path.join(sourceDir, CONFIG.ENTRY))
const entryFileName = path.basename(entryFilePath)
const pluginsConfig = projectConfig.plugins || {}

const pkgPath = path.join(__dirname, './rn/pkg')

let depTree = {}

let isBuildingStyles = {}
const styleDenpendencyTree = {}

function isEntryFile (filePath) {
  return path.basename(filePath) === entryFileName
}

function compileDepStyles (filePath, styleFiles) {
  if (isBuildingStyles[filePath] || styleFiles.length === 0) {
    return Promise.resolve({})
  }
  isBuildingStyles[filePath] = true
  return Promise.all(styleFiles.map(async p => { // to css string
    const filePath = path.join(p)
    const fileExt = path.extname(filePath)
    Util.printLog(Util.pocessTypeEnum.COMPILE, _.camelCase(fileExt).toUpperCase(), filePath)
    return StyleProcess.loadStyle({filePath, pluginsConfig})
  })).then(resList => { // postcss
    return Promise.all(resList.map(item => {
      return StyleProcess.postCSS({...item, projectConfig})
    }))
  }).then(resList => {
    let styleObjectEntire = {}
    resList.forEach(item => {
      let styleObject = StyleProcess.getStyleObject({css: item.css, filePath: item.filePath})
      // validate styleObject
      StyleProcess.validateStyle({styleObject, filePath: item.filePath})

      Object.assign(styleObjectEntire, styleObject)
      if (filePath !== entryFilePath) { // 非入口文件，合并全局样式
        Object.assign(styleObjectEntire, _.get(styleDenpendencyTree, [entryFilePath, 'styleObjectEntire'], {}))
      }
      styleDenpendencyTree[filePath] = {
        styleFiles,
        styleObjectEntire
      }
    })
    return JSON.stringify(styleObjectEntire, null, 2)
  }).then(css => {
    let tempFilePath = filePath.replace(sourceDir, tempPath)
    const basename = path.basename(tempFilePath, path.extname(tempFilePath))
    tempFilePath = path.join(path.dirname(tempFilePath), `${basename}_styles.js`)

    StyleProcess.writeStyleFile({css, tempFilePath})
  }).catch((e) => {
    throw new Error(e)
  })
}

function initProjectFile () {
  // generator app.json
  const appJsonObject = Object.assign({
    name: _.camelCase(require(path.join(process.cwd(), 'package.json')).name)
  }, projectConfig.rn && projectConfig.rn.appJson)
  // generator .${tempPath}/package.json TODO JSON.parse 这种写法可能会有隐患
  const pkgTempObj = JSON.parse(
    ejs.render(
      fs.readFileSync(pkgPath, 'utf-8'), {
        projectName: projectConfig.projectName,
        version: getPkgVersion()
      }
    ).replace(/(\r\n|\n|\r|\s+)/gm, '')
  )
  const dependencies = require(path.join(process.cwd(), 'package.json')).dependencies
  pkgTempObj.dependencies = Object.assign({}, pkgTempObj.dependencies, dependencies)

  // Copy bin/crna-entry.js ?
  // const crnaEntryPath = path.join(path.dirname(npmProcess.resolveNpmSync('@tarojs/rn-runner')), 'src/bin/crna-entry.js')

  const indexJsStr = `
  import {AppRegistry} from 'react-native';
  import App from './${entryFileName}';
  import {name as appName} from './app.json';

  AppRegistry.registerComponent(appName, () => App);`

  fs.writeFileSync(path.join(tempDir, 'index.js'), indexJsStr)
  Util.printLog(Util.pocessTypeEnum.GENERATE, 'index.js', path.join(tempPath, 'index.js'))
  fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify(appJsonObject, null, 2))
  Util.printLog(Util.pocessTypeEnum.GENERATE, 'app.json', path.join(tempPath, 'app.json'))
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgTempObj, null, 2))
  Util.printLog(Util.pocessTypeEnum.GENERATE, 'package.json', path.join(tempPath, 'package.json'))
  // fs.copySync(crnaEntryPath, path.join(tempDir, 'bin/crna-entry.js'))
  // Util.printLog(Util.pocessTypeEnum.COPY, 'crna-entry.js', path.join(tempPath, 'bin/crna-entry.js'))
}

async function processFile (filePath) {
  if (!fs.existsSync(filePath)) {
    return
  }
  const dirname = path.dirname(filePath)
  const distDirname = dirname.replace(sourceDir, tempDir)
  let distPath = path.format({dir: distDirname, base: path.basename(filePath)})
  const code = fs.readFileSync(filePath, 'utf-8')
  if (Util.REG_STYLE.test(filePath)) {
    // do something
  } else if (Util.REG_SCRIPTS.test(filePath)) {
    if (Util.REG_TYPESCRIPT.test(filePath)) {
      distPath = distPath.replace(/\.(tsx|ts)(\?.*)?$/, '.js')
    }
    Util.printLog(Util.pocessTypeEnum.COMPILE, _.camelCase(path.extname(filePath)).toUpperCase(), filePath)
    // transformJSCode
    let transformResult = transformJSCode({code, filePath, isEntryFile: isEntryFile(filePath), projectConfig})
    const jsCode = transformResult.code
    fs.ensureDirSync(distDirname)
    fs.writeFileSync(distPath, Buffer.from(jsCode))
    // compileDepStyles
    const styleFiles = transformResult.styleFiles
    depTree[filePath] = styleFiles
    await compileDepStyles(filePath, styleFiles)
  } else {
    fs.ensureDirSync(distDirname)
    fs.copySync(filePath, distPath)
    Util.printLog(Util.pocessTypeEnum.COPY, _.camelCase(path.extname(filePath)).toUpperCase(), filePath)
  }
}

/**
 * @description 编译文件，安装依赖
 * @returns {Promise}
 */
function buildTemp () {
  fs.ensureDirSync(path.join(tempPath, 'bin'))
  return new Promise((resolve, reject) => {
    klaw(sourceDir)
      .on('data', file => {
        if (!file.stats.isDirectory()) {
          processFile(file.path)
        }
      })
      .on('end', () => {
        initProjectFile()
        if (!fs.existsSync(path.join(tempPath, 'node_modules'))) {
          console.log()
          console.log(chalk.yellow('开始安装依赖~'))
          process.chdir(tempPath)
          let command
          if (Util.shouldUseYarn()) {
            command = 'yarn'
          } else if (Util.shouldUseCnpm()) {
            command = 'cnpm install'
          } else {
            command = 'npm install'
          }
          shelljs.exec(command, {silent: false})
        }
        resolve()
      })
  })
}

function buildBundle () {
  process.chdir(tempDir)
  fs.ensureDirSync('./tmp')
  execSync(`node node_modules/react-native/local-cli/cli.js bundle --entry-file ./index.js --bundle-output ./tmp/index.bundle --assets-dest ./tmp`,
    {stdio: 'inherit'})
}

async function perfWrap (callback, args) {
  isBuildingStyles = {} // 清空
  // 后期可以优化，不编译全部
  let t0 = performance.now()
  await callback(args)
  let t1 = performance.now()
  Util.printLog(Util.pocessTypeEnum.COMPILE, `编译完成，花费${Math.round(t1 - t0)} ms`)
}

function watchFiles () {
  const watcher = chokidar.watch(path.join(sourceDir), {
    ignored: /(^|[/\\])\../,
    persistent: true,
    ignoreInitial: true
  })

  watcher
    .on('ready', () => {
      console.log()
      console.log(chalk.gray('初始化完毕，监听文件修改中...'))
      console.log()
    })
    .on('add', filePath => {
      const relativePath = path.relative(appPath, filePath)
      Util.printLog(Util.pocessTypeEnum.CREATE, '添加文件', relativePath)
      perfWrap(buildTemp)
    })
    .on('change', filePath => {
      const relativePath = path.relative(appPath, filePath)
      Util.printLog(Util.pocessTypeEnum.MODIFY, '文件变动', relativePath)
      if (Util.REG_SCRIPTS.test(filePath)) {
        perfWrap(processFile, filePath)
      }
      if (Util.REG_STYLE.test(filePath)) {
        _.forIn(depTree, (styleFiles, jsFilePath) => {
          if (styleFiles.indexOf(filePath) > -1) {
            perfWrap(processFile, jsFilePath)
          }
        })
      }
    })
    .on('unlink', filePath => {
      const relativePath = path.relative(appPath, filePath)
      Util.printLog(Util.pocessTypeEnum.UNLINK, '删除文件', relativePath)
      perfWrap(buildTemp)
    })
    .on('error', error => console.log(`Watcher error: ${error}`))
}

async function build ({watch}) {
  process.env.TARO_ENV = Util.BUILD_TYPES.RN
  fs.ensureDirSync(tempPath)
  let t0 = performance.now()
  await buildTemp()
  let t1 = performance.now()
  Util.printLog(Util.pocessTypeEnum.COMPILE, `编译完成，花费${Math.round(t1 - t0)} ms`)

  if (watch) {
    watchFiles()
    startServerInNewWindow()
  } else {
    buildBundle()
  }
}

/**
 * @description run packager server
 * copy from react-native/local-cli/runAndroid/runAndroid.js
 */
function startServerInNewWindow (port = 8081) {
  // set up OS-specific filenames and commands
  const isWindows = /^win/.test(process.platform)
  const scriptFile = isWindows
    ? 'launchPackager.bat'
    : 'launchPackager.command'
  const packagerEnvFilename = isWindows ? '.packager.bat' : '.packager.env'
  const portExportContent = isWindows
    ? `set RCT_METRO_PORT=${port}`
    : `export RCT_METRO_PORT=${port}`

  // set up the launchpackager.(command|bat) file
  const scriptsDir = path.resolve(tempPath, './node_modules', 'react-native', 'scripts')
  const launchPackagerScript = path.resolve(scriptsDir, scriptFile)
  const procConfig = {cwd: scriptsDir}
  const terminal = process.env.REACT_TERMINAL

  // set up the .packager.(env|bat) file to ensure the packager starts on the right port
  const packagerEnvFile = path.join(
    tempPath,
    'node_modules',
    'react-native',
    'scripts',
    packagerEnvFilename
  )

  // ensure we overwrite file by passing the 'w' flag
  fs.writeFileSync(packagerEnvFile, portExportContent, {
    encoding: 'utf8',
    flag: 'w'
  })

  if (process.platform === 'darwin') {
    if (terminal) {
      return child_process.spawnSync(
        'open',
        ['-a', terminal, launchPackagerScript],
        procConfig
      )
    }
    return child_process.spawnSync('open', [launchPackagerScript], procConfig)
  } else if (process.platform === 'linux') {
    procConfig.detached = true
    if (terminal) {
      return child_process.spawn(
        terminal,
        ['-e', 'sh ' + launchPackagerScript],
        procConfig
      )
    }
    return child_process.spawn('sh', [launchPackagerScript], procConfig)
  } else if (/^win/.test(process.platform)) {
    procConfig.detached = true
    procConfig.stdio = 'ignore'
    return child_process.spawn(
      'cmd.exe',
      ['/C', launchPackagerScript],
      procConfig
    )
  } else {
    console.log(
      chalk.red(
        `Cannot start the packager. Unknown platform ${process.platform}`
      )
    )
  }
}

module.exports = {build}
