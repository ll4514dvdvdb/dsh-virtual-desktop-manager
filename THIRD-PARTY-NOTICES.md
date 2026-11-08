# Third-party notices

This project is an independent implementation of the Windows virtual desktop COM
interface. No source code is copied from the projects below; what is shared is the
interface contract (interface GUIDs and vtable method ordering), which was derived from
their publicly available reverse-engineering work.

| Project | License | What was used |
| --- | --- | --- |
| [MScholtes/VirtualDesktop](https://github.com/MScholtes/VirtualDesktop) | MIT, Copyright (c) 2017 Markus Scholtes | COM interface signatures (IIDs, vtable ordering) |
| [saimanish1/logitech-ipc-protocol](https://github.com/saimanish1/logitech-ipc-protocol) | see upstream | cross-validation of the same interface details |

These projects are not affiliated with this one and do not endorse it.

The MIT text in `LICENSE` covers this project's own code only.