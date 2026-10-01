# 用本地源码构建产物覆盖 npm 安装版：容器里跑的就是这份代码。
#
# 覆盖层里已经是 node_modules/@deepseek-ai/<包>/... ，所以整棵子树合并进
# CLI 的 nested node_modules，而不是它本身——否则会多出一层 node_modules。
ARG BASE_IMAGE=dsh-web:0.2.0-rc.2
FROM ${BASE_IMAGE}

COPY image-overlay/node_modules/ /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/
COPY image-overlay/manifest.json /opt/dsh-local-build/manifest.json

# 让部署方一眼看出这个镜像来自本地构建而不是 npm 发行版。
RUN printf 'local source overlay\n' > /opt/dsh-local-build/SOURCE
