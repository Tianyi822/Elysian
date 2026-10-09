package kardia_test

import (
	"context"
	"elysian/server/internal/agent/kardia"
	"fmt"
)

func ExampleContext() {
	ctx := context.Background()
	root := kardia.NewContext()
	provider, err := root.Plugin(&kardia.Plugin{Name: "settings", Apply: func(c *kardia.Context, config any) (kardia.Disposable, error) {
		return c.Provide("settings", config, nil)
	}}, 4)
	if err != nil {
		panic(err)
	}
	if _, err = provider.Await(ctx); err != nil {
		panic(err)
	}
	consumer, err := root.Plugin(&kardia.Plugin{Name: "consumer", Inject: kardia.InjectMap{"settings": nil}, Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
		value, err := c.Get("settings")
		if err != nil {
			return nil, err
		}
		fmt.Println(value)
		return nil, nil
	}}, nil)
	if err != nil {
		panic(err)
	}
	if _, err = consumer.Await(ctx); err != nil {
		panic(err)
	}
	if err = provider.Update(ctx, 8, false); err != nil {
		panic(err)
	}
	if _, err = consumer.Await(ctx); err != nil {
		panic(err)
	}
	if err = consumer.Dispose(ctx); err != nil {
		panic(err)
	}
	if err = provider.Dispose(ctx); err != nil {
		panic(err)
	}
	// Output:
	// 4
	// 8
}
