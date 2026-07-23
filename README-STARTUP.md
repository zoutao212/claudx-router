# 🚀 Claude Code Router 启动指南

## 📋 快速启动

### 1. 构建项目
```bash
build.bat
```
- 安装依赖
- 构建所有包
- 生成生产版本

### 2. 开发模式启动
```bash
start-dev.bat
```
- 热重载开发模式
- 详细调试日志
- 适合开发和测试

### 3. 生产模式启动
```bash
start-prod.bat
```
- 优化性能
- 包含完整 UI
- 适合生产使用

### 4. 自定义端口启动
```bash
start-prod.bat 8080
```
- 在端口 8080 启动服务

## ⚙️ 配置文件位置

配置文件：`C:\Users\zouta\.claude-code-router\config.json`

当前配置的 Provider：
- **novacode** (GPT-5.4 via OpenAI Responses API)
- **zhipu** (智谱 GLM-4.6)
- **openrouter** (OpenRouter Polaris Alpha)

## 🌐 访问地址

启动后可访问：
- **API 端点**: http://127.0.0.1:8080/v1/messages
- **Web UI**: http://127.0.0.1:8080
- **配置查看**: http://127.0.0.1:8080/api/config
- **转换器列表**: http://127.0.0.1:8080/api/transformers

## 🔧 Claude Code 配置

在终端中设置：
```cmd
set ANTHROPIC_API_KEY=<your-ccr-api-key>
set ANTHROPIC_BASE_URL=http://localhost:3457/v1
```

然后启动 Claude Code：
```cmd
claude-code --model gpt-5.4
```

## 📝 使用说明

1. **首次使用**：先运行 `build.bat` 构建项目
2. **日常开发**：使用 `start-dev.bat` 获得最佳开发体验
3. **生产部署**：使用 `start-prod.bat` 获得最佳性能
4. **问题排查**：查看日志输出，检查配置文件

## 🔍 故障排除

### 常见问题

1. **pnpm 未找到**
   ```cmd
   npm install -g pnpm
   ```

2. **端口被占用**
   - 修改配置文件中的 PORT
   - 或使用自定义端口：`start-prod.bat 8080`

3. **配置文件错误**
   - 检查 `C:\Users\zouta\.claude-code-router\config.json`
   - 确保语法正确，API 密钥有效

4. **构建失败**
   - 删除 `node_modules` 重新安装
   - 检查网络连接

### 日志查看

开发模式会显示详细日志，生产模式日志保存在：
`C:\Users\zouta\.claude-code-router\logs\`

## 🎯 模型使用

当前默认路由：`novacode,gpt-5.4`

可在 Claude Code 中直接使用：
- 普通对话：自动路由到 GPT-5.4
- 复杂推理：自动路由到 GPT-5.4
- 长文本处理：自动路由到 GPT-5.4

---

**注意**: 确保你的 novacode API 密钥有效且有足够的配额。
