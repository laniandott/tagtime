import os
import sys
import subprocess

# 确保工作目录为当前脚本所在目录
base_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(base_dir)

# 配置 TagTime 服务所需的环境变量
env = os.environ.copy()
env["PORT"] = "3000"
env["HOST"] = "::"
env["DATABASE_URL"] = "file:./data/tagtime.db"
env["DATA_DIR"] = "./data"
env["PYTHONIOENCODING"] = "utf-8"

# 找到 node.exe 路径
node_bin = r"C:\Program Files\nodejs\node.exe"
if not os.path.exists(node_bin):
    node_bin = "node"

target_script = os.path.join(base_dir, "apps", "server", "dist", "index.js")

print(f"[TagTime Python Service Wrapper]")
print(f"Working Dir: {base_dir}")
print(f"Starting Node Backend: {target_script}")

# 启动 Node 后端进程
p = subprocess.Popen(
    [node_bin, target_script],
    env=env,
    cwd=base_dir
)

# 阻塞等待，与 NSSM 服务生命周期完全同步
sys.exit(p.wait())
