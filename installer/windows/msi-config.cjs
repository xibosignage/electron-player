/**
 * Identity and versioning for the Windows MSI.
 *
 * Kept in its own module so the build, CI and anyone reading the packaging
 * document see the same numbers, and so changing them is a reviewable diff
 * rather than an edit inside a build script.
 */

/**
 * The MSI's version is deliberately NOT the player's version.
 *
 * The legacy .NET player ships as 4.407.2. Windows compares installed products
 * field by field, so the player's own 4.0.9 reads as OLDER and an MSI built with
 * it would refuse to install on a fielded screen, reporting that a newer version
 * is already present. The MSI therefore carries its own series, high enough to
 * clear the legacy package for good.
 *
 * KNOWN SPEC DEVIATION, accepted deliberately. Microsoft documents the minor
 * field's maximum as 255 (https://learn.microsoft.com/en-us/windows/win32/msi/productversion),
 * and 500 exceeds it. The legacy package has shipped out of spec in exactly the
 * same way for years with working upgrades, which is the evidence this rests on.
 * If the VM upgrade test shows the replacement not happening, the version is the
 * first thing to suspect: raise MAJOR instead and leave MINOR within 255.
 */
const MSI_VERSION_MAJOR = 4;
const MSI_VERSION_MINOR = 500;

/**
 * Inherited from the legacy player's Advanced Installer project. This single
 * value is what makes the new package an upgrade of the old player rather than
 * a second product beside it, and it can never change.
 */
const UPGRADE_CODE = '443E7578-7FEF-47E8-9078-04DDA8B96F3A';

const PRODUCT_NAME = 'Xibo Player';
const MANUFACTURER = 'Xibo Signage Ltd';

/**
 * Build the MSI version from package.json.
 *
 * The build field tracks `versionCode`, which already rises with every release,
 * so the version increases on its own and nobody has to remember to bump it.
 *
 * @param {object} packageJSON The player's package.json, parsed.
 * @return {string} A three-field MSI ProductVersion.
 */
function msiVersion(packageJSON) {
  const versionCode = Number(packageJSON.versionCode);

  if (!Number.isInteger(versionCode) || versionCode < 0) {
    throw new Error(
      `versionCode in package.json must be a non-negative integer, got ` +
        `${JSON.stringify(packageJSON.versionCode)}. The MSI version is derived ` +
        `from it.`);
  }

  // The build field is 16 bits. Overflowing it would make a newer release look
  // older than its predecessor and silently stop upgrading fielded screens.
  if (versionCode > 65535) {
    throw new Error(
      `versionCode ${versionCode} exceeds the 65535 maximum for the MSI build ` +
        `field. Raise MSI_VERSION_MINOR in installer/windows/msi-config.cjs and ` +
        `restart the build field from a lower number.`);
  }

  return `${MSI_VERSION_MAJOR}.${MSI_VERSION_MINOR}.${versionCode}`;
}

module.exports = {
  MANUFACTURER,
  MSI_VERSION_MAJOR,
  MSI_VERSION_MINOR,
  PRODUCT_NAME,
  UPGRADE_CODE,
  msiVersion,
};
