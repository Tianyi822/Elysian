// platform-helper is deliberately independent of the panel and its dependencies.
package main

import (
	"elysian/server/internal/platformhelper"
	"fmt"
	"os"
)

func main() {
	output, err := platformhelper.Run(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Print(output)
}
