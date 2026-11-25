package docker

import "testing"

func TestReadPublishedPortsUsesLiveBindings(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		return 200, `[{"Id":"ctr","Names":["/gateway"],"Ports":[
			{"PrivatePort":80,"Type":"tcp"},
			{"IP":"::","PrivatePort":80,"PublicPort":12080,"Type":"tcp"},
			{"IP":"0.0.0.0","PrivatePort":80,"PublicPort":12080,"Type":"tcp"},
			{"IP":"0.0.0.0","PrivatePort":80,"PublicPort":12080,"Type":"tcp"},
			{"IP":"127.0.0.1","PrivatePort":53,"PublicPort":5353,"Type":"udp"}]}]`,
			call.Method == "GET" && call.Path == "/containers/json" && len(call.Query) == 0
	})
	ports, err := ReadPublishedPorts(t.Context(), engine)
	if err != nil || len(ports) != 3 {
		t.Fatalf("unexpected bindings: %#v, %v", ports, err)
	}
	if ports[0].HostPort != 5353 || ports[0].ContainerName != "gateway" ||
		ports[1].HostIP != "0.0.0.0" || ports[2].HostIP != "::" || ports[2].ContainerPort != 80 {
		t.Fatalf("lost live addresses or remapped ports: %#v", ports)
	}
	engine.script = func(engineCall) (int, string, bool) { return 503, "", true }
	if ports, err := ReadPublishedPorts(t.Context(), engine); err == nil || ports != nil {
		t.Fatalf("engine failure looked like an empty inventory: %#v, %v", ports, err)
	}
}
