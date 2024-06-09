const esbuild = require("esbuild");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const ncp = require("ncp").ncp;
const { rimrafSync } = require("rimraf");

function execCmdSync(cmd) {
  try {
    execSync(cmd);
  } catch (err) {
    console.error(`Error executing command '${cmd}': `, err.output.toString());
    process.exit(1);
  }
}

const esbuildOutputFile = "out/index.js";
const targets = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
];

const assetBackups = [
  "node_modules/win-ca/lib/crypt32-ia32.node.bak",
  "node_modules/win-ca/lib/crypt32-x64.node.bak",
];

let esbuildOnly = false;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--esbuild-only") {
    esbuildOnly = true;
  }
  if (process.argv[i - 1] === "--target") {
    targets = [process.argv[i]];
  }
}

const targetToLanceDb = {
  "darwin-arm64": "@lancedb/vectordb-darwin-arm64",
  "darwin-x64": "@lancedb/vectordb-darwin-x64",
  "linux-arm64": "@lancedb/vectordb-linux-arm64-gnu",
  "linux-x64": "@lancedb/vectordb-linux-x64-gnu",
  "win32-x64": "@lancedb/vectordb-win32-x64-msvc",
};

async function installNodeModuleInTempDirAndCopyToCurrent(package, toCopy) {
  console.log(`Copying ${package} to ${toCopy}`);
  // This is a way to install only one package without npm trying to install all the dependencies
  // Create a temporary directory for installing the package
  const adjustedName = toCopy.replace(/^@/, "").replace("/", "-");
  const tempDir = path.join(
    __dirname,
    "tmp",
    `continue-node_modules-${adjustedName}`,
  );
  const currentDir = process.cwd();

  // Remove the dir we will be copying to
  rimrafSync(`node_modules/${toCopy}`);

  // Ensure the temporary directory exists
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Move to the temporary directory
    process.chdir(tempDir);

    // Initialize a new package.json and install the package
    execCmdSync(`npm init -y && npm i -f ${package} --no-save`);

    console.log(
      `Contents of: ${package}`,
      fs.readdirSync(path.join(tempDir, "node_modules", toCopy)),
    );

    // Copy the installed package back to the current directory
    await new Promise((resolve, reject) => {
      ncp(
        path.join(tempDir, "node_modules", toCopy),
        path.join(currentDir, "node_modules", toCopy),
        { dereference: true },
        (error) => {
          if (error) {
            console.error(`[error] Error copying ${package} package`, error);
            reject(error);
          } else {
            resolve();
          }
        },
      );
    });
  } finally {
    // Clean up the temporary directory
    // rimrafSync(tempDir);

    // Return to the original directory
    process.chdir(currentDir);
  }
}

(async () => {
  //   console.log("[info] Building with ncc...");
  //   execCmdSync(`npx ncc build src/index.ts -o out`);

  // Copy node_modules for pre-built binaries
  const DYNAMIC_IMPORTS = [
    // "esbuild",
    // "@esbuild",
    // // "@lancedb",
    // "posthog-node",
    // "@octokit",
  ];
  fs.mkdirSync("out/node_modules", { recursive: true });
  fs.mkdirSync("bin/node_modules", { recursive: true });

  await Promise.all(
    DYNAMIC_IMPORTS.map(
      (mod) =>
        new Promise((resolve, reject) => {
          ncp(
            `node_modules/${mod}`,
            `out/node_modules/${mod}`,
            function (error) {
              if (error) {
                console.error(`[error] Error copying ${mod}`, error);
                reject(error);
              } else {
                resolve();
              }
            },
          );
          ncp(
            `node_modules/${mod}`,
            `bin/node_modules/${mod}`,
            function (error) {
              if (error) {
                console.error(`[error] Error copying ${mod}`, error);
                reject(error);
              } else {
                resolve();
              }
            },
          );
        }),
    ),
  );
  console.log(`[info] Copied ${DYNAMIC_IMPORTS.join(", ")}`);

  console.log("[info] Downloading prebuilt lancedb...");
  for (const target of targets) {
    if (targetToLanceDb[target]) {
      console.log(`[info] Downloading ${target}...`);
      await installNodeModuleInTempDirAndCopyToCurrent(
        targetToLanceDb[target],
        "@lancedb",
      );
    }
  }

  console.log("[info] Cleaning up artifacts from previous builds...");

  // delete asset backups generated by previous pkg invocations, if present
  for (const assetPath of assetBackups) {
    fs.rmSync(assetPath, { force: true });
  }

  console.log("[info] Building with esbuild...");
  // Bundles the extension into one file
  await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    outfile: esbuildOutputFile,
    external: ["esbuild", ...DYNAMIC_IMPORTS, "./xhr-sync-worker.js", "vscode"],
    format: "cjs",
    platform: "node",
    sourcemap: true,
    loader: {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      ".node": "file",
    },

    // To allow import.meta.path for transformers.js
    // https://github.com/evanw/esbuild/issues/1492#issuecomment-893144483
    inject: ["./importMetaUrl.js"],
    define: { "import.meta.url": "importMetaUrl" },
  });

  // Copy over any worker files
  fs.cpSync(
    "../core/node_modules/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js",
    "out/xhr-sync-worker.js",
  );

  if (esbuildOnly) {
    return;
  }

  console.log("[info] Building binaries with pkg...");
  for (const target of targets) {
    const targetDir = `bin/${target}`;
    fs.mkdirSync(targetDir, { recursive: true });
    console.log(`[info] Building ${target}...`);
    execCmdSync(
      `npx pkg --no-bytecode --public-packages "*" --public pkgJson/${target} --out-path ${targetDir}`,
    );

    // Download and unzip prebuilt sqlite3 binary for the target
    const downloadUrl = `https://github.com/TryGhost/node-sqlite3/releases/download/v5.1.7/sqlite3-v5.1.7-napi-v6-${
      target === "win32-arm64" ? "win32-ia32" : target
    }.tar.gz`;
    execCmdSync(`curl -L -o ${targetDir}/build.tar.gz ${downloadUrl}`);
    execCmdSync(`cd ${targetDir} && tar -xvzf build.tar.gz`);
    fs.copyFileSync(
      `${targetDir}/build/Release/node_sqlite3.node`,
      `${targetDir}/node_sqlite3.node`,
    );
    fs.unlinkSync(`${targetDir}/build.tar.gz`);
    fs.rmSync(`${targetDir}/build`, {
      recursive: true,
      force: true,
    });

    // Download and unzip prebuilt esbuild binary for the target
    console.log(`[info] Downloading esbuild for ${target}...`);
    // Version is pinned to 0.20.0 in package.json to make sure that they match
    execCmdSync(
      `curl -o ${targetDir}/esbuild.tgz https://registry.npmjs.org/@esbuild/${target}/-/${target}-0.20.0.tgz`,
    );
    execCmdSync(`tar -xzvf ${targetDir}/esbuild.tgz -C ${targetDir}`);
    if (target.startsWith("win32")) {
      fs.cpSync(`${targetDir}/package/esbuild.exe`, `${targetDir}/esbuild.exe`);
    } else {
      fs.cpSync(`${targetDir}/package/bin/esbuild`, `${targetDir}/esbuild`);
    }
    fs.rmSync(`${targetDir}/esbuild.tgz`);
    fs.rmSync(`${targetDir}/package`, {
      force: true,
      recursive: true,
    });
  }
  // execCmdSync(
  //   `npx pkg out/index.js --target node18-darwin-arm64 --no-bytecode --public-packages "*" --public -o bin/pkg`
  // );
  console.log("[info] Done!");
})();