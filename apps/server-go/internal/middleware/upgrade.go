package middleware

import (
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"elysian/server/internal/seam"
)

// wsReadLimit 帧读取上限 64 KiB，对齐 TS maxPayloadLength（超限读错误、应用层收不到
// message ≡ 1006）。
const wsReadLimit int64 = 64 * 1024

// wsCloseWriteTimeout 关闭帧写出时限：尽力送达，超时即弃。
const wsCloseWriteTimeout = time.Second

// upgrader 是唯一的 gorilla 升级器；CheckOrigin 恒 true——同源校验是调用方的显式
// 前置步骤（拒绝天然发生在升级之前：handler 先做 403/503/404/409 等普通响应）。
var upgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool { return true },
}

// Upgrade WS 升级公共件（go-plan §3.7）：gorilla 封装，产出 seam.WsConn，
// ReadLimit = 64 KiB。拒绝天然发生在升级之前——调用方先做 403/503/404/409 等
// 普通响应再调本函数。
func Upgrade(w http.ResponseWriter, r *http.Request) (seam.WsConn, error) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(wsReadLimit)
	return newWsConn(conn), nil
}

// wsConn 是 seam.WsConn 的 gorilla 实现：串行化写出、自计数待写字节、幂等关闭。
type wsConn struct {
	conn     *websocket.Conn
	writeMu  sync.Mutex
	closed   atomic.Bool
	buffered atomic.Int64
}

func newWsConn(conn *websocket.Conn) *wsConn {
	return &wsConn{conn: conn}
}

// SendText 在连接 OPEN 时发送文本帧并返回 true；非 OPEN 或写出失败静默丢弃返回 false。
// 写出期间自计数累加，供 BufferedAmount 水位判定。
func (c *wsConn) SendText(text string) bool {
	if c.closed.Load() {
		return false
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed.Load() {
		return false
	}
	c.buffered.Add(int64(len(text)))
	err := c.conn.WriteMessage(websocket.TextMessage, []byte(text))
	c.buffered.Add(-int64(len(text)))
	if err != nil {
		c.closed.Store(true)
		return false
	}
	return true
}

// BufferedAmount 返回已提交未写出到网络的应用层字节数（当前阻塞中的写出长度）。
func (c *wsConn) BufferedAmount() int64 {
	return c.buffered.Load()
}

// Close 幂等发送关闭帧并断开底层连接。
func (c *wsConn) Close(code int, reason string) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed.Swap(true) {
		return
	}
	deadline := time.Now().Add(wsCloseWriteTimeout)
	_ = c.conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(code, reason), deadline)
	_ = c.conn.Close()
}

// ReadMessage 阻塞读下一帧；由使用方在独立 goroutine 驱动。
func (c *wsConn) ReadMessage() (int, []byte, error) {
	return c.conn.ReadMessage()
}
