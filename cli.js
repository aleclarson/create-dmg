#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const meow = require('meow');
const appdmg = require('appdmg');
const plist = require('plist');
const Ora = require('ora');
const execa = require('execa');
const addLicenseAgreementIfNeeded = require('./sla.js');
const composeIcon = require('./compose-icon');

if (process.platform !== 'darwin') {
	console.error('macOS only');
	process.exit(1);
}

const cli = meow(`
	Usage
	  $ create-dmg <app> [destination]

	Options
	  --overwrite          Overwrite existing DMG with the same name
	  --identity=<value>   Manually set code signing identity (automatic by default)
	  --dmg-title=<value>  Manually set title of DMG volume (only used if app name is >27 character limit)

	Examples
	  $ create-dmg 'Lungo.app'
	  $ create-dmg 'Lungo.app' Build/Releases
`, {
	flags: {
		overwrite: {
			type: 'boolean'
		},
		identity: {
			type: 'string'
		},
		dmgTitle: {
			type: 'string'
		}
	}
});

let [appPath, destinationPath] = cli.input;

if (!appPath) {
	console.error('Specify an app');
	process.exit(1);
}

if (!destinationPath) {
	destinationPath = process.cwd();
}

const infoPlistPath = path.join(appPath, 'Contents/Info.plist');

let infoPlist;
try {
	infoPlist = fs.readFileSync(infoPlistPath, 'utf8');
} catch (error) {
	if (error.code === 'ENOENT') {
		console.error(`Could not find \`${path.relative(process.cwd(), appPath)}\``);
		process.exit(1);
	}

	throw error;
}

const ora = new Ora('Creating DMG');
ora.start();

async function init() {
	let appInfo;
	try {
		appInfo = plist.parse(infoPlist);
	} catch (_) {
		const {stdout} = await execa('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', infoPlistPath]);
		appInfo = plist.parse(stdout);
	}

	const appName = appInfo.CFBundleDisplayName || appInfo.CFBundleName;
	const appIconName = appInfo.CFBundleIconFile.replace(/\.icns/, '');
	const dmgTitle = appName.length > 27 ? (cli.flags.dmgTitle || appName) : appName;
	const dmgPath = destinationPath.endsWith('.dmg')
		? destinationPath
		: path.join(destinationPath, `${appName} ${appInfo.CFBundleShortVersionString}.dmg`);

	if (cli.flags.overwrite) {
		try {
			fs.unlinkSync(dmgPath);
		} catch (_) {}
	}

	ora.text = 'Creating icon';
	const composedIconPath = await composeIcon(path.join(appPath, 'Contents/Resources', `${appIconName}.icns`));

	const minSystemVersion = (Object.prototype.hasOwnProperty.call(appInfo, 'LSMinimumSystemVersion') && appInfo.LSMinimumSystemVersion.length > 0) ? appInfo.LSMinimumSystemVersion.toString() : '10.11';
	const minorVersion = Number(minSystemVersion.split('.')[1]) || 0;
	const dmgFormat = (minorVersion >= 11) ? 'ULFO' : 'UDZO'; // ULFO requires 10.11+
	ora.info(`Minimum runtime ${minSystemVersion} detected, using ${dmgFormat} format`).start();

	const ee = appdmg({
		target: dmgPath,
		basepath: process.cwd(),
		specification: {
			title: dmgTitle,
			icon: composedIconPath,
			//
			// Use transparent background and `background-color` option when this is fixed:
			// https://github.com/LinusU/node-appdmg/issues/135
			background: path.join(__dirname, 'assets/dmg-background.png'),
			'icon-size': 160,
			format: dmgFormat,
			window: {
				size: {
					width: 660,
					height: 400
				}
			},
			contents: [
				{
					x: 180,
					y: 170,
					type: 'file',
					path: appPath
				},
				{
					x: 480,
					y: 170,
					type: 'link',
					path: '/Applications'
				}
			]
		}
	});

	ee.on('progress', info => {
		if (info.type === 'step-begin') {
			ora.text = info.title;
		}
	});

	ee.on('finish', async () => {
		try {
			ora.text = 'Adding Software License Agreement if needed';
			await addLicenseAgreementIfNeeded(dmgPath, dmgFormat);

			ora.text = 'Replacing DMG icon';
			// `seticon`` is a native tool to change files icons (Source: https://github.com/sveinbjornt/osxiconutils)
			await execa(path.join(__dirname, 'seticon'), [composedIconPath, dmgPath]);

			ora.text = 'Code signing DMG';
			const {stdout} = await execa('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);

			let identity;
			stdout.split(/\r?\n/).find(line => {
				const match = /^  \d+\) \S+ "([^"]+)"/.exec(line)
				if (match) {
					identity = match[1]
					if (cli.flags.identity) {
						if (identity.includes(cli.flags.identity)) {
							return true
						}
					} else if (
						[ 'Developer ID Application:',
						  'Mac Developer:',
						  'Apple Development:',
						].some(str => identity.startsWith(str))
					) {
						return true
					}
				}
			})

			if (!identity) {
				const error = new Error();
				error.stderr = 'No suitable code signing identity found';
				throw error;
			}

			await execa('/usr/bin/codesign', ['--sign', identity, dmgPath]);
			const {stderr} = await execa('/usr/bin/codesign', [dmgPath, '--display', '--verbose=2']);

			const match = /^Authority=(.*)$/m.exec(stderr);
			if (!match) {
				ora.fail('Not code signed');
				process.exit(1);
			}

			ora.info(`Code signing identity: ${match[1]}`).start();
			ora.succeed('DMG created');
		} catch (error) {
			ora.fail(`Code signing failed. The DMG is fine, just not code signed.\n${Object.prototype.hasOwnProperty.call(error, 'stderr') ? error.stderr.trim() : error}`);
			process.exit(2);
		}
	});

	ee.on('error', error => {
		ora.fail(`Building the DMG failed. ${error}`);
		process.exit(1);
	});
}

init().catch(error => {
	ora.fail(error);
	process.exit(1);
});
