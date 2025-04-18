# Sowing Taker 自动签到机器人

适用于Taker Sowing协议的自动签到机器人，带有图形界面

## 功能特点

- 自动化的Taker Sowing协议签到
- 直观的图形用户界面
- 支持多个钱包
- 支持为每个钱包配置代理
- 实时状态更新和倒计时显示
- 活动日志记录
- 自动领取奖励和重启签到周期

## 安装方法

1. 克隆此仓库:
```
git clone https://github.com/yourusername/Sowing-Taker-Auto-Bot.git
cd Sowing-Taker-Auto-Bot
```

2. 安装依赖:
```
npm install
```

3. 在根目录创建`.env`文件，添加您的私钥:
```
PRIVATE_KEY_1=你的私钥1
PRIVATE_KEY_2=你的私钥2
PRIVATE_KEY_3=你的私钥3
# 根据需要添加更多
```

4. (可选) 创建`proxies.txt`文件，每行添加一个代理:
```
http://用户名:密码@IP:端口
http://用户名:密码@IP:端口
# 或者不带认证
http://ip:端口
```

## 使用方法

启动机器人:
```
npm start
```

开发模式(带开发者工具):
```
npm run dev
```

![image](https://github.com/user-attachments/assets/f18980f7-7401-442b-aea6-5cbe0d108c9a)


### 图形界面导航

1. **钱包选择**: 使用下拉菜单切换不同的钱包。
2. **机器人控制**:
   - **启动机器人**: 初始化并开始所有钱包的自动签到。
   - **停止机器人**: 停止所有签到操作。
   - **刷新令牌**: 刷新所有钱包的认证令牌。
3. **钱包信息**: 显示所选钱包的详细信息，包括Taker积分、签到次数和奖励数量。
4. **签到状态**: 显示当前签到状态、下次签到时间和倒计时。
5. **活动日志**: 显示所有操作和事件的日志记录。

## 构建可执行文件

构建独立的可执行文件:
```
npm run build
```

## 免责声明

本机器人仅供教育目的使用。使用风险自负。
