# waybar-led-control
Waybar module to control remote [jackw01/led-control](https://github.com/jackw01/led-control) instance

Assumes a server at raspberrypi.local:8080 that accepts WebSocket messages and passes them along to the actual running led-control instance. 

Work-in-progress:
- Command line arguments
- More reliable behavior on system suspend
- Closer integration with led-control to eliminate WebSocket-to-server jump at endpoint
- Faster first connect
- Packaging as an actual waybar module

Recommended waybar config:
```JSON
    "custom/led": {
        "exec": "~/.config/waybar/waybar-led-control/index.js",
        "format": "{}",
        "smooth-scrolling-interval": 1, // adjust to your liking, the interval is 10%+- brightness
        "on-click-right": "echo -n palette_up | socat - UNIX-CONNECT:/tmp/waybar-led",
        "on-click-middle": "echo -n palette_down | socat - UNIX-CONNECT:/tmp/waybar-led",
        "on-scroll-up": "echo -n brightness_up | socat - UNIX-CONNECT:/tmp/waybar-led",
        "on-scroll-down": "echo -n brightness_down | socat - UNIX-CONNECT:/tmp/waybar-led",
        "on-click": "echo -n power | socat - UNIX-CONNECT:/tmp/waybar-led"
    }
```