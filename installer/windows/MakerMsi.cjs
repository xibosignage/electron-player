const {execFileSync, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {MakerBase} = require('@electron-forge/maker-base');

const {MANUFACTURER, PRODUCT_NAME, UPGRADE_CODE, msiVersion} =
    require('./msi-config.cjs');

const WXS_FILE = path.join(__dirname, 'xibo-player.wxs');

/** Electron Forge architecture names mapped to the ones `wix build` accepts. */
const WIX_ARCH = {
  arm64: 'arm64',
  ia32: 'x86',
  x64: 'x64',
};

const INSTALL_HINT = [
  'The WiX toolset was not found.',
  '',
  'It is a .NET global tool. With the .NET SDK installed, run:',
  '',
  '    dotnet tool install --global wix --version "[6.0.0,7.0.0)"',
  '',
  'Then reopen the terminal so the dotnet global tools directory is on PATH, or set',
  'WIX_PATH to the full path of wix.exe.',
].join('\n');

/**
 * Find the `wix` executable, as an absolute path.
 *
 * An absolute path matters: arguments here include values with spaces, and
 * running through a shell to let PATH resolve a bare "wix" would hand those
 * arguments to the shell to re-split.
 *
 * `dotnet tool install --global` also puts the tool in a directory that is only
 * added to PATH for shells started afterwards, so look there directly before
 * falling back to a PATH lookup.
 *
 * @return {string|null} An executable path, or null if WiX is not installed.
 */
function resolveWix() {
  if (process.env.WIX_PATH) {
    return fs.existsSync(process.env.WIX_PATH) ? process.env.WIX_PATH : null;
  }

  const toolsPath = path.join(os.homedir(), '.dotnet', 'tools', 'wix.exe');
  if (fs.existsSync(toolsPath)) return toolsPath;

  const lookup = spawnSync('where', ['wix'], {encoding: 'utf8'});
  if (lookup.status !== 0) return null;

  // Trimming each line makes splitting on the newline alone enough.
  const found = lookup.stdout.split('\n').find((line) => line.trim());
  return found ? found.trim() : null;
}

/**
 * Builds the machine-wide MSI that replaces the legacy .NET Windows player.
 *
 * Electron Forge has an official WiX maker, but it wraps electron-wix-msi, which
 * is tied to the end-of-life WiX 3 toolset, cannot express the Start-up shortcut
 * or product identity this package needs, and carries its own Squirrel-based
 * updater. The authoring in xibo-player.wxs is built directly instead.
 */
class MakerMsi extends MakerBase {
  /**
   * @param {...*} args Config and platforms, passed straight to MakerBase.
   */
  constructor(...args) {
    super(...args);
    this.name = 'msi';
    this.defaultPlatforms = ['win32'];
  }

  /**
   * @return {boolean} Whether an MSI can be built here.
   */
  isSupportedOnCurrentPlatform() {
    // `wix build` runs on Linux and macOS, but the result is only ever installed
    // on Windows and the release build is a Windows job, so there is nothing to
    // gain from building it elsewhere.
    if (process.platform !== 'win32') return false;

    if (!resolveWix()) {
      console.error(`\n[maker-msi] ${INSTALL_HINT}\n`);
      return false;
    }

    return true;
  }

  /**
   * @param {object} opts Forge maker options.
   * @return {Promise<string[]>} Absolute paths to the artifacts produced.
   */
  async make({dir, makeDir, targetArch, packageJSON}) {
    const wix = resolveWix();
    if (!wix) throw new Error(INSTALL_HINT);

    const arch = WIX_ARCH[targetArch];
    if (!arch) {
      throw new Error(
        `[maker-msi] No WiX architecture for Forge arch "${targetArch}".`);
    }

    const version = msiVersion(packageJSON);
    const outPath = path.resolve(makeDir, 'msi', targetArch);
    await this.ensureDirectory(outPath);

    const msiPath = path.join(
      outPath, `${packageJSON.name}-${packageJSON.version}-${arch}.msi`);

    // The two versions differ on purpose and the difference has bitten us before,
    // so state both wherever a build log will be read.
    console.log(
      `[maker-msi] Building ${path.basename(msiPath)} — ` +
        `player ${packageJSON.version}, MSI ProductVersion ${version}`);

    const args = [
      'build',
      WXS_FILE,
      '-arch', arch,
      '-define', `AppDir=${path.resolve(dir)}`,
      '-define', `ProductVersion=${version}`,
      '-define', `ProductName=${PRODUCT_NAME}`,
      '-define', `Manufacturer=${MANUFACTURER}`,
      '-define', `UpgradeCode=${UPGRADE_CODE}`,
      '-out', msiPath,
      '-nologo',
    ];

    execFileSync(wix, args, {stdio: 'inherit'});

    return [msiPath];
  }
}

module.exports = MakerMsi;
module.exports.MakerMsi = MakerMsi;
