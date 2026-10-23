"""Static public errors shared without importing filesystem or transport modules."""


class Denied(Exception):
    def __init__(self, code="invalid-request", status=400):
        self.code, self.status = code, status
        super().__init__(code)
