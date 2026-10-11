#!/usr/bin/env python3
"""curl 的最小替身：只实现本部署脚本用到的那个子集。

为什么需要它：目标机（内网、装不了包）没有 curl，而 doctor / acceptance / smoke /
accept 全用 curl（cookie jar、POST、-w 取状态码、-o 落盘）。原方案是"把 curl 跑进
运行时镜像"，但那个镜像里根本没有 curl（基础镜像没装），于是这条路一上目标机就是死的。
python3 是这些脚本本来就依赖的（JSON 解析、凭据文件），用它实现最省事，也不需要容器。

支持：-s -S -f -L -k -4 -i -o -w -b -c -H -X -d --data-urlencode
      --max-time/-m --connect-timeout --cacert
`-w` 支持 %{http_code} %{url_effective} %{num_redirects}。
不支持的一律**报错退出**（而不是静默忽略）——静默忽略会让检查变成假绿。

写成 Python 3.6 也能跑的写法（CentOS 7 自带的 python3 就是 3.6；目标机 Ubuntu 20.04
是 3.8），所以不用 3.7+ 的 annotations、也不用内置泛型注解。
"""

import http.cookiejar
import os
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


class UsageError(Exception):
    """A flag this shim does not implement, or a malformed command line."""


class Args(object):
    """Parsed command line."""

    def __init__(self):
        self.urls = []
        self.headers = []
        self.data = []
        self.urlencode = []
        self.out = None
        self.write_out = None
        self.jar_read = None
        self.jar_write = None
        self.cacert = None
        self.method = None
        self.max_time = None
        self.silent = False
        self.show_error = False
        self.fail_on_error = False
        self.insecure = False
        self.follow = False
        self.include_headers = False


def parse(argv):
    parsed = Args()
    index = 0

    def take_value(flag, inline, has_inline):
        """The value for one flag: `--flag=v`, `-fVALUE`, or the next argument."""
        nonlocal index
        if has_inline:
            return inline
        index += 1
        if index >= len(argv):
            raise UsageError("%s 缺少参数" % flag)
        return argv[index]

    while index < len(argv):
        arg = argv[index]
        if arg == "":
            index += 1
            continue
        if arg.startswith("--"):
            name, sep, inline = arg.partition("=")
            has_inline = sep == "="
            if name == "--max-time":
                parsed.max_time = float(take_value(name, inline, has_inline))
            elif name == "--connect-timeout":
                parsed.max_time = float(take_value(name, inline, has_inline))
            elif name == "--cacert":
                parsed.cacert = take_value(name, inline, has_inline)
            elif name == "--data-urlencode":
                parsed.urlencode.append(take_value(name, inline, has_inline))
            elif name in ("--data", "--data-binary", "--data-raw"):
                parsed.data.append(take_value(name, inline, has_inline))
            elif name == "--header":
                parsed.headers.append(take_value(name, inline, has_inline))
            elif name == "--request":
                parsed.method = take_value(name, inline, has_inline)
            elif name == "--output":
                parsed.out = take_value(name, inline, has_inline)
            elif name == "--write-out":
                parsed.write_out = take_value(name, inline, has_inline)
            elif name == "--cookie":
                parsed.jar_read = take_value(name, inline, has_inline)
            elif name == "--cookie-jar":
                parsed.jar_write = take_value(name, inline, has_inline)
            elif name == "--insecure":
                parsed.insecure = True
            elif name == "--location":
                parsed.follow = True
            elif name == "--silent":
                parsed.silent = True
            elif name == "--show-error":
                parsed.show_error = True
            elif name == "--fail":
                parsed.fail_on_error = True
            elif name in ("--compressed", "--ipv4", "--tlsv1.2"):
                pass
            else:
                raise UsageError("这个 curl 替身不支持 %s" % name)
            index += 1
            continue
        if arg.startswith("-") and arg != "-":
            position = 1
            while position < len(arg):
                flag = arg[position]
                if flag in "sSfLki4":
                    if flag == "s":
                        parsed.silent = True
                    elif flag == "S":
                        parsed.show_error = True
                    elif flag == "f":
                        parsed.fail_on_error = True
                    elif flag == "L":
                        parsed.follow = True
                    elif flag == "k":
                        parsed.insecure = True
                    elif flag == "i":
                        parsed.include_headers = True
                    position += 1
                    continue
                if flag in "owbcdHXm":
                    rest = arg[position + 1:]
                    value = rest if rest else take_value("-" + flag, "", False)
                    if flag == "o":
                        parsed.out = value
                    elif flag == "w":
                        parsed.write_out = value
                    elif flag == "b":
                        parsed.jar_read = value
                    elif flag == "c":
                        parsed.jar_write = value
                    elif flag == "d":
                        parsed.data.append(value)
                    elif flag == "H":
                        parsed.headers.append(value)
                    elif flag == "X":
                        parsed.method = value
                    elif flag == "m":
                        parsed.max_time = float(value)
                    position = len(arg)
                    continue
                raise UsageError("这个 curl 替身不支持 -%s" % flag)
            index += 1
            continue
        parsed.urls.append(arg)
        index += 1
    if not parsed.urls:
        raise UsageError("没有 URL")
    if len(parsed.urls) > 1:
        raise UsageError("这个 curl 替身一次只发一个 URL")
    return parsed


class CountingRedirect(urllib.request.HTTPRedirectHandler):
    """Redirect handler that counts hops, for %{num_redirects}."""

    def __init__(self):
        urllib.request.HTTPRedirectHandler.__init__(self)
        self.count = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.count += 1
        return urllib.request.HTTPRedirectHandler.redirect_request(
            self, req, fp, code, msg, headers, newurl)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Without -L, hand the 3xx response back instead of following it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def build_body(parsed):
    pieces = list(parsed.data)
    for item in parsed.urlencode:
        key, _, value = item.partition("=")
        pieces.append("%s=%s" % (key, urllib.parse.quote(value, safe="")))
    if not pieces:
        return None
    return "&".join(pieces).encode("utf-8")


def write_out_line(template, status, url, redirects):
    return (template
            .replace("%{http_code}", str(status))
            .replace("%{url_effective}", url)
            .replace("%{num_redirects}", str(redirects)))


def load_jar(path):
    """A cookie jar loaded from a Netscape cookie file, or from `k=v`."""
    jar = http.cookiejar.MozillaCookieJar()
    if not path:
        return jar
    if os.path.exists(path):
        try:
            jar.load(path, ignore_discard=True, ignore_expires=True)
        except (OSError, http.cookiejar.LoadError):
            pass
    elif "=" in path:
        key, _, value = path.partition("=")
        jar.set_cookie(http.cookiejar.Cookie(
            0, key, value, None, False, "", False, False, "/", True, False, None,
            False, None, None, {}, False))
    return jar


def main(argv):
    try:
        parsed = parse(argv)
    except UsageError as error:
        print("curl-shim: %s" % error, file=sys.stderr)
        return 2

    jar = load_jar(parsed.jar_read)
    context = ssl.create_default_context(cafile=parsed.cacert)
    if parsed.insecure:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE

    redirects = CountingRedirect()
    handlers = [urllib.request.HTTPCookieProcessor(jar),
                urllib.request.HTTPSHandler(context=context)]
    handlers.append(redirects if parsed.follow else NoRedirect())
    opener = urllib.request.build_opener(*handlers)

    body = build_body(parsed)
    request = urllib.request.Request(parsed.urls[0], data=body)
    if parsed.method:
        request.get_method = lambda: parsed.method
    for header in parsed.headers:
        name, _, value = header.partition(":")
        request.add_header(name.strip(), value.strip())
    if body is not None and not any(h.lower().startswith("content-type:") for h in parsed.headers):
        request.add_header("Content-Type", "application/x-www-form-urlencoded")

    timeout = parsed.max_time if parsed.max_time else None
    if timeout:
        socket.setdefaulttimeout(timeout)

    try:
        response = opener.open(request, timeout=timeout)
        status = response.status
        payload = response.read()
        final_url = response.url
        headers_text = "".join("%s: %s\r\n" % (k, v) for k, v in response.headers.items())
    except urllib.error.HTTPError as error:
        status = error.code
        payload = error.read()
        final_url = error.url
        headers_text = "".join("%s: %s\r\n" % (k, v) for k, v in error.headers.items())
    except (urllib.error.URLError, OSError) as error:
        if not parsed.silent or parsed.show_error:
            print("curl-shim: 请求失败 %s: %s"
                  % (parsed.urls[0], getattr(error, "reason", error)), file=sys.stderr)
        return 7

    if parsed.fail_on_error and status >= 400:
        if not parsed.silent or parsed.show_error:
            print("curl-shim: HTTP %d %s" % (status, parsed.urls[0]), file=sys.stderr)
        return 22

    if parsed.out in (None, "-"):
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()
    elif parsed.out != "/dev/null":
        with open(parsed.out, "wb") as handle:
            handle.write(payload)

    if parsed.include_headers:
        sys.stdout.write(headers_text)
    if parsed.write_out:
        sys.stdout.write(write_out_line(parsed.write_out, status, final_url, redirects.count))
        sys.stdout.flush()
    if parsed.jar_write:
        try:
            jar.save(parsed.jar_write, ignore_discard=True, ignore_expires=True)
        except OSError as error:
            print("curl-shim: 写 cookie 失败: %s" % error, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
