import os
from pathlib import Path

from server.processing import Store, run_operation


class Earth:
    def __init__(self):
        self.store = Store(Path(os.environ.get("OPEN_EARTH_DATA", ".earth")) / "datasets")
        self._bindings = None

    def sync(self, namespace, context):
        from server.workspace import WorkspaceBindings
        if self._bindings is None:
            self._bindings = WorkspaceBindings(self)
        return self._bindings.sync(namespace, context)

    def publish(self, namespace):
        return self._bindings.publish(namespace) if self._bindings else []

    def visualize(self, namespace, key, kind="ds"):
        if self._bindings is None:
            raise ValueError("Connect the notebook workspace before visualizing a copy.")
        return self._bindings.visualize(namespace, key, kind)

    def layers(self):
        return self.store.items()

    def path(self, identifier):
        return str(self.store.source(identifier))

    def assets(self, identifier):
        import planetary_computer
        item = self.store.get(identifier)
        item = item.get("notebook_source", item)
        if item["kind"] != "stac":
            return {"data": str(self.store.path(identifier) / item["filename"])}
        return {name: planetary_computer.sign(asset["href"]) for name, asset in item["assets"].items()}

    def add(self, path, name=None):
        return self.store.register(path, name)

    def run(self, layer, operation, params=None, other=None):
        return run_operation(self.store, layer, operation, params, other)


earth = Earth()