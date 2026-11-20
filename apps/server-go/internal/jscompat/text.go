package jscompat

// UTF16Length 统计字符串的 UTF-16 码元数，增补平面字符计两个。
func UTF16Length(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}
