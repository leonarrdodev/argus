module.exports = {
  apps: [
    {
      name: "argus-core",
      script: "core/index.ts",
      interpreter: "node_modules/.bin/tsx", // Usando tsx para resolver os imports magicamente
      watch: false,
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "argus-brain",
      script: "scripts/brain.py",
      interpreter: "venv/bin/python3",
      watch: false,
      env: {
        PYTHONUNBUFFERED: "1" 
      }
    }
  ]
};